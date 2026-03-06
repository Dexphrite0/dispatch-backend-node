require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const Ably = require("ably");
const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function uploadImage(base64, folder = "dispatch") {
  if (!base64) return null;
  if (base64.startsWith("http")) return base64;
  const result = await cloudinary.uploader.upload(base64, { folder, resource_type: "image" });
  return result.secure_url;
}

const app = express();
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json({ limit: "20mb" }));

const ably = new Ably.Rest({ key: process.env.ABLY_API_KEY });

mongoose.connect(process.env.MONGO_URL).then(() => console.log("✓ MongoDB connected"));

// ── Schemas ───────────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  firstName: String, lastName: String, email: { type: String, unique: true },
  password: String, role: String, profilePic: String, backgroundImage: String,
  coverImage: String, phone: String, location: String, website: String,
  bio: String, createdAt: Number, online: Boolean, last_seen: Number,
});
const User = mongoose.model("users", UserSchema);

const MessageSchema = new mongoose.Schema({
  user_id: String, id: String, from: String, subject: String, preview: String,
  body: String, timestamp: String, read: Boolean, starred: Boolean, role: String,
  isWelcome: Boolean, isAdmin: Boolean, createdAt: Number, unread: Boolean,
});
const Message = mongoose.model("messages", MessageSchema);

const ChatMessageSchema = new mongoose.Schema({
  conversation_id: String, sender_id: String, content: String,
  timestamp: Number, read: Boolean, deleted: Boolean, reply_to: Object,
});
const ChatMessage = mongoose.model("chat_messages", ChatMessageSchema);

const ConversationSchema = new mongoose.Schema({
  participants: [String], last_message: String, last_message_time: Number,
  last_message_sender: String, unread: Object,
});
const Conversation = mongoose.model("conversations", ConversationSchema);

const ViewedEmailSchema = new mongoose.Schema({ user_id: String, emailIds: [String] });
const ViewedEmail = mongoose.model("viewed_emails", ViewedEmailSchema);

const IncidentSchema = new mongoose.Schema({
  title:       { type: String, required: true },
  description: { type: String, required: true },
  priority:    { type: String, enum: ["low","medium","high","critical"], default: "medium" },
  status:      { type: String, enum: ["open","in_progress","resolved","closed"], default: "open" },
  category:    { type: String, default: "General" },
  visibility:  { type: String, enum: ["public","private"], default: "public" },
  created_by:  { type: String, required: true },
  assigned_to: { type: String, default: null },
  comments: [{
    content: String, author_id: String,
    author_name: String, created_at: { type: Date, default: Date.now },
  }],
  reopen_request: {
    pending:       { type: Boolean, default: false },
    reason:        { type: String, default: "" },
    requested_by:  { type: String, default: null },
    requested_at:  { type: Date, default: null },
  },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

const Incident = mongoose.model("Incident", IncidentSchema);

// ── Helpers ───────────────────────────────────────────────────────────────
function formatTimestamp(ts) {
  return new Date(ts).toLocaleString("en-US", { month: "short", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function formatRelative(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60)    return "just now";
  if (diff < 3600)  return `${Math.floor(diff/60)} mins ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)} hrs ago`;
  if (diff < 604800) return `${Math.floor(diff/86400)} days ago`;
  return `${Math.floor(diff/2592000)} months ago`;
}

async function broadcastOnlineStatus(userId, online, last_seen) {
  const convs = await Conversation.find({ participants: userId });
  for (const conv of convs) {
    for (const pid of conv.participants) {
      if (pid !== userId) {
        ably.channels.get(`user-${pid}`).publish("online_status", { user_id: userId, online, last_seen });
      }
    }
  }
}

async function getDisplayName(userId) {
  if (!userId) return "Unknown";
  const user = await User.findById(userId).select("role _id").lean().catch(() => null);
  if (!user) return "Unknown";
  if (user.role === "admin") return "ADMIN";
  const role = user.role
    ? user.role.charAt(0).toUpperCase() + user.role.slice(1)
    : "User";
  const shortId = userId.slice(-6);
  return `${role}(${shortId})`;
}

// ── Auth ──────────────────────────────────────────────────────────────────
app.post("/api/signup", async (req, res) => {
  const { firstName, lastName, email, password } = req.body;
  if (await User.findOne({ email })) return res.status(400).json({ error: "Email already exists" });
  const hashed = await bcrypt.hash(password, 4);
  const now = Date.now();
  const user = await User.create({ firstName, lastName, email, password: hashed, createdAt: now });
  const userId = user._id.toString();
  await Message.create({ user_id: userId, id: "welcome-email", from: "Dispatch Team", subject: "Welcome to Dispatch! 🎉", preview: "Get started with your dashboard", body: "Welcome to Dispatch!\nThank you for creating your account.\n\nBest regards,\nThe Dispatch Team", timestamp: "just now", createdAt: now, unread: true, starred: false, role: "admin", isWelcome: true });
  res.json({ message: "User created", user_id: userId, firstName, lastName, email, createdAt: formatTimestamp(now), createdAtRelative: formatRelative(now) });
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user) return res.status(401).json({ error: "User not found" });
  if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error: "Invalid password" });
  const userId = user._id.toString();
  res.json({ message: "Login successful", user_id: userId, firstName: user.firstName, lastName: user.lastName, email: user.email, role: user.role, createdAt: formatTimestamp(user.createdAt), createdAtRelative: formatRelative(user.createdAt) });
});

app.post("/api/set-role", async (req, res) => {
  const { user_id, role } = req.body;
  const result = await User.updateOne({ _id: user_id }, { $set: { role } });
  if (!result.modifiedCount) return res.status(400).json({ error: "User not found" });
  res.json({ message: `Role set to ${role}` });
});

// ── Online status ─────────────────────────────────────────────────────────
app.post("/api/user/:id/online", async (req, res) => {
  await User.updateOne({ _id: req.params.id }, { $set: { online: true } }).catch(() => {});
  broadcastOnlineStatus(req.params.id, true, null);
  res.json({ message: "Online" });
});

app.post("/api/user/:id/offline", async (req, res) => {
  const now = Date.now();
  await User.updateOne({ _id: req.params.id }, { $set: { online: false, last_seen: now } }).catch(() => {});
  broadcastOnlineStatus(req.params.id, false, now);
  res.json({ message: "Offline" });
});

// ── User ──────────────────────────────────────────────────────────────────
app.get("/api/user/:id", async (req, res) => {
  const user = await User.findById(req.params.id).catch(() => null);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ _id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email, role: user.role, profilePic: user.profilePic, backgroundImage: user.backgroundImage, coverImage: user.coverImage, phone: user.phone, location: user.location, website: user.website, bio: user.bio, online: user.online || false, last_seen: user.last_seen, createdAt: formatTimestamp(user.createdAt), createdAtRelative: formatRelative(user.createdAt) });
});

app.post("/api/user/:id/profile-pic", async (req, res) => {
  const url = await uploadImage(req.body.profilePic, "dispatch/avatars");
  if (!url) return res.status(400).json({ error: "Upload failed" });
  await User.updateOne({ _id: req.params.id }, { $set: { profilePic: url } });
  res.json({ message: "Profile pic saved", url });
});

app.post("/api/user/:id/background", async (req, res) => {
  await User.updateOne({ _id: req.params.id }, { $set: { backgroundImage: req.body.backgroundImage } });
  res.json({ message: "Background image saved" });
});

app.post("/api/user/:id/cover-image", async (req, res) => {
  const url = await uploadImage(req.body.coverImage, "dispatch/covers");
  if (!url) return res.status(400).json({ error: "Upload failed" });
  await User.updateOne({ _id: req.params.id }, { $set: { coverImage: url } });
  res.json({ message: "Cover image saved", url });
});

app.post("/api/user/:id/profile", async (req, res) => {
  const fields = {};
  ["firstName","lastName","bio","phone","location","website","role"].forEach(k => { if (req.body[k] !== undefined) fields[k] = req.body[k]; });
  await User.updateOne({ _id: req.params.id }, { $set: fields });
  res.json({ message: "Profile updated" });
});

app.get("/api/users", async (req, res) => {
  const users = await User.find({}, "_id firstName lastName email role profilePic");
  res.json(users.map(u => ({ _id: u._id, firstName: u.firstName, lastName: u.lastName, email: u.email, role: u.role, profilePic: u.profilePic?.startsWith('http') ? u.profilePic : null })));
});

// ── Messages (inbox) ──────────────────────────────────────────────────────
app.get("/api/user/:id/messages", async (req, res) => {
  const msgs = await Message.find({ user_id: req.params.id });
  res.json(msgs);
});

app.post("/api/user/:id/messages", async (req, res) => {
  await Message.deleteMany({ user_id: req.params.id });
  for (const msg of req.body.messages) {
    await Message.create({ ...msg, user_id: req.params.id, createdAt: Date.now() });
  }
  res.json({ message: "Messages saved successfully" });
});

app.post("/api/user/:uid/message/:mid", async (req, res) => {
  const fields = {};
  if (req.body.read    !== undefined) fields.read    = req.body.read;
  if (req.body.starred !== undefined) fields.starred = req.body.starred;
  await Message.updateOne({ user_id: req.params.uid, _id: req.params.mid }, { $set: fields });
  res.json({ message: "Updated" });
});

app.post("/api/user/:uid/message/:mid/read", async (req, res) => {
  await Message.updateOne({ user_id: req.params.uid, id: req.params.mid }, { $set: { unread: false } });
  res.json({ message: "Marked as read" });
});

app.delete("/api/user/:uid/message/:mid", async (req, res) => {
  await Message.deleteOne({ user_id: req.params.uid, $or: [{ id: req.params.mid }, { _id: req.params.mid }] });
  res.json({ message: "Deleted" });
});

// ── Viewed emails ─────────────────────────────────────────────────────────
app.get("/api/user/:id/viewed-emails", async (req, res) => {
  const doc = await ViewedEmail.findOne({ user_id: req.params.id });
  res.json({ viewedEmails: doc?.emailIds || [] });
});

app.post("/api/user/:id/viewed-emails", async (req, res) => {
  const result = await ViewedEmail.updateOne({ user_id: req.params.id }, { $addToSet: { emailIds: req.body.emailId } });
  if (!result.modifiedCount) await ViewedEmail.create({ user_id: req.params.id, emailIds: [req.body.emailId] });
  res.json({ message: "Marked as viewed" });
});

// ── Admin ─────────────────────────────────────────────────────────────────
app.post("/api/admin/send-email", async (req, res) => {
  const { subject, body, userIds, from } = req.body;
  let sent = 0;
  for (const uid of userIds) {
    const ts = Date.now();
    await Message.create({ user_id: uid, id: `admin-email-${ts}`, from, subject, preview: body.slice(0, 100), body, timestamp: "just now", createdAt: ts, unread: true, starred: false, role: "admin", isAdmin: true });
    sent++;
  }
  res.json({ message: "Email sent", count: sent, requested: userIds.length });
});

// ── Management ────────────────────────────────────────────────────────────
app.post("/api/management/send-email", async (req, res) => {
  const { subject, body, userIds, from } = req.body;
  let sent = 0;
  for (const uid of userIds) {
    const ts = Date.now();
    await Message.create({ user_id: uid, id: `management-email-${ts}`, from, subject, preview: body.slice(0, 100), body, timestamp: "just now", createdAt: ts, unread: true, starred: false, role: "management", isManagement: true });
    sent++;
  }
  res.json({ message: "Email sent", count: sent, requested: userIds.length });
});

// ── Chat ──────────────────────────────────────────────────────────────────
app.post("/api/chat/send", async (req, res) => {
  const { to, content, sender_id, reply_to } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: "Empty message" });
  const timestamp = Date.now();
  let conv = await Conversation.findOne({ participants: { $all: [sender_id, to], $size: 2 } });
  if (!conv) conv = await Conversation.create({ participants: [sender_id, to], last_message: content, last_message_time: timestamp, last_message_sender: sender_id, unread: {} });
  const convId = conv._id.toString();
  const msg = await ChatMessage.create({ conversation_id: convId, sender_id, content, timestamp, read: false, deleted: false, reply_to: reply_to || null });
  const msgData = { _id: msg._id.toString(), conversation_id: convId, sender_id, content, timestamp, read: false, deleted: false, reply_to: reply_to || null };
  await Conversation.updateOne({ _id: conv._id }, { $set: { last_message: content, last_message_time: timestamp, last_message_sender: sender_id }, $inc: { [`unread.${to}`]: 1 } });
  res.json({ message: msgData });
});

app.post("/api/chat/conversation/:convId/read", async (req, res) => {
  const { reader_id } = req.body;
  const convId = req.params.convId;
  await ChatMessage.updateMany({ conversation_id: convId, sender_id: { $ne: reader_id }, read: false }, { $set: { read: true } });
  await Conversation.updateOne({ _id: convId }, { $set: { [`unread.${reader_id}`]: 0 } });
  res.json({ message: "Marked as read" });
});

app.delete("/api/chat/message/:msgId", async (req, res) => {
  await ChatMessage.updateOne({ _id: req.params.msgId }, { $set: { deleted: true, content: "This message was deleted" } });
  res.json({ message: "Deleted" });
});

app.get("/api/chat/users/:userId", async (req, res) => {
  const user = await User.findById(req.params.userId).catch(() => null);
  if (!user) return res.status(404).json({ error: "User not found" });
  const allowed = { customer: ["management"], management: ["customer", "admin"], admin: ["management", "customer"] }[user.role] || [];
  if (!allowed.length) return res.json([]);
  const users = await User.find({ role: { $in: allowed }, _id: { $ne: user._id } });
  res.json(users.map(u => ({ _id: u._id, firstName: u.firstName, lastName: u.lastName, role: u.role, profilePic: u.profilePic, online: u.online || false, last_seen: u.last_seen })));
});

app.get("/api/chat/conversations/:userId", async (req, res) => {
  const uid = req.params.userId;
  const convs = await Conversation.find({ participants: uid }).sort({ last_message_time: -1 });
  const otherIds = convs.map(c => c.participants.find(p => p !== uid)).filter(Boolean);
  const users = await User.find({ _id: { $in: otherIds } });
  const userMap = {};
  users.forEach(u => { userMap[u._id.toString()] = u; });
  const result = convs.map(conv => {
    const otherId = conv.participants.find(p => p !== uid);
    const other = userMap[otherId];
    if (!other) return null;
    const unread = conv.unread?.[uid] || 0;
    return {
      conversation_id: conv._id.toString(),
      other_user: {
        _id: otherId, firstName: other.firstName, lastName: other.lastName,
        role: other.role, profilePic: other.profilePic?.startsWith('http') ? other.profilePic : null,
        online: other.online && other.last_seen && (Date.now() - other.last_seen < 120000) ? true : (other.online && !other.last_seen ? true : false),
        last_seen: other.last_seen
      },
      last_message: conv.last_message, last_message_time: conv.last_message_time,
      last_message_sender: conv.last_message_sender, unread
    };
  }).filter(Boolean);
  res.json(result);
});

app.get("/api/chat/conversation/:convId/messages", async (req, res) => {
  const msgs = await ChatMessage.find({ conversation_id: req.params.convId }).sort({ timestamp: 1 });
  res.json(msgs.map(m => ({ _id: m._id.toString(), conversation_id: m.conversation_id, sender_id: m.sender_id, content: m.content, timestamp: m.timestamp, read: m.read, deleted: m.deleted, reply_to: m.reply_to })));
});

// ── Incidents ─────────────────────────────────────────────────────────────

// ── Incidents ─────────────────────────────────────────────────────────────
app.get("/api/incidents/public", async (req, res) => {
  try {
    const incidents = await Incident.find({ visibility: "public" }).sort({ created_at: -1 }).lean();
    res.json(incidents);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch public incidents" });
  }
});

app.get("/api/incidents/user/:userId", async (req, res) => {
  try {
    const incidents = await Incident.find({ created_by: req.params.userId }).sort({ created_at: -1 }).lean();
    res.json(incidents);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch incidents" });
  }
});

app.get("/api/incidents", async (req, res) => {
  try {
    const { status, priority, assigned_to } = req.query;
    const filter = {};
    if (status)      filter.status      = status;
    if (priority)    filter.priority    = priority;
    if (assigned_to) filter.assigned_to = assigned_to;
    const incidents = await Incident.find(filter).sort({ created_at: -1 }).lean();
    res.json(incidents);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch incidents" });
  }
});

app.post("/api/incidents", async (req, res) => {
  try {
    const { title, description, priority, category, created_by, visibility } = req.body;
    if (!title || !description || !created_by) return res.status(400).json({ error: "Missing required fields" });
    const incident = await Incident.create({ title, description, priority, category, created_by, visibility: visibility || "public" });
    res.json({ incident });
  } catch (err) {
    res.status(500).json({ error: "Failed to create incident" });
  }
});

app.patch("/api/incidents/:id/status", async (req, res) => {
  try {
    const allowed = ["open", "in_progress", "resolved", "closed"];
    if (!allowed.includes(req.body.status)) return res.status(400).json({ error: "Invalid status" });
    const incident = await Incident.findByIdAndUpdate(req.params.id, { status: req.body.status, updated_at: Date.now() }, { new: true }).lean();
    if (!incident) return res.status(404).json({ error: "Not found" });

    // ── Inbox notification to creator ──
    const statusLabels = { in_progress: "In Progress", resolved: "Resolved", closed: "Closed", open: "Reopened" };
    const label = statusLabels[req.body.status];
    if (label && incident.created_by) {
      const ts = Date.now();
      await Message.create({
        user_id: incident.created_by,
        id: `incident-status-${incident._id}-${ts}`,
        from: "Dispatch System",
        subject: `Incident ${label}: ${incident.title}`,
        preview: `Your incident has been marked as ${label}.`,
        body: `Your incident "${incident.title}" (INC-${incident._id.toString().slice(-6).toUpperCase()}) has been marked as ${label}.`,
        timestamp: "just now", createdAt: ts, unread: true, starred: false, role: "admin",
      });
    }

    res.json({ incident });
  } catch (err) {
    res.status(500).json({ error: "Failed to update status" });
  }
});

app.patch("/api/incidents/:id/assign", async (req, res) => {
  try {
    const incident = await Incident.findByIdAndUpdate(req.params.id, { assigned_to: req.body.assigned_to, status: "in_progress", updated_at: Date.now() }, { new: true }).lean();
    if (!incident) return res.status(404).json({ error: "Not found" });

    // ── Inbox notification to creator ──
    if (incident.created_by) {
      const ts = Date.now();
      await Message.create({
        user_id: incident.created_by,
        id: `incident-assigned-${incident._id}-${ts}`,
        from: "Dispatch System",
        subject: `Incident Assigned: ${incident.title}`,
        preview: "A professional has been assigned to your incident.",
        body: `Good news! A professional has been assigned to your incident "${incident.title}" (INC-${incident._id.toString().slice(-6).toUpperCase()}) and it is now in progress.`,
        timestamp: "just now", createdAt: ts, unread: true, starred: false, role: "admin",
      });
    }

    res.json({ incident });
  } catch (err) {
    res.status(500).json({ error: "Failed to assign incident" });
  }
});



app.patch("/api/incidents/:id/reopen", async (req, res) => {
  try {
    const { reason, author_id } = req.body;
    const author_name = await getDisplayName(author_id);
    const newComment = { content: `Reopened: ${reason}`, author_id, author_name, created_at: new Date() };
    const incident = await Incident.findByIdAndUpdate(
      req.params.id,
      { status: "open", updated_at: Date.now(), $push: { comments: newComment } },
      { new: true }
    ).lean();
    if (!incident) return res.status(404).json({ error: "Not found" });
    res.json({ incident });
  } catch (err) {
    res.status(500).json({ error: "Failed to reopen" });
  }
});

app.get("/api/incidents/:id/comments", async (req, res) => {
  try {
    const incident = await Incident.findById(req.params.id).select("comments").lean();
    if (!incident) return res.status(404).json({ error: "Not found" });
    res.json(incident.comments || []);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch comments" });
  }
});

app.post("/api/incidents/:id/comments", async (req, res) => {
  try {
    const { content, author_id } = req.body;
    if (!content || !author_id) return res.status(400).json({ error: "Missing fields" });
    const author_name = await getDisplayName(author_id);
    const newComment = { content, author_id, author_name, created_at: new Date() };
    const incident = await Incident.findByIdAndUpdate(req.params.id, { $push: { comments: newComment }, updated_at: Date.now() }, { new: true }).lean();
    if (!incident) return res.status(404).json({ error: "Not found" });
    res.json({ comment: incident.comments[incident.comments.length - 1] });
  } catch (err) {
    res.status(500).json({ error: "Failed to add comment" });
  }
});

app.delete("/api/incidents/:id", async (req, res) => {
  try {
    await Incident.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete" });
  }
});

app.post("/api/incidents/broadcast", async (req, res) => {
  try {
    const { subject, message, incidentId, from } = req.body;
    const users = await User.find({}, "_id");
    const ts = Date.now();
    for (const u of users) {
      await Message.create({
        user_id: u._id.toString(),
        id: `broadcast-${ts}`,
        from: from || "ADMIN",
        subject: `🚨 ${subject}`,
        preview: message.slice(0, 100),
        body: message,
        timestamp: "just now",
        createdAt: ts,
        unread: true,
        starred: false,
        role: "admin",
        isAdmin: true,
      });
    }
    res.json({ message: "Broadcast sent", count: users.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to broadcast" });
  }
});

app.post("/api/incidents/:id/reopen-request", async (req, res) => {
  try {
    const { reason, author_id } = req.body;
    if (!reason || !author_id) return res.status(400).json({ error: "Missing fields" });

    const incident = await Incident.findByIdAndUpdate(
      req.params.id,
      { reopen_request: { pending: true, reason, requested_by: author_id, requested_at: new Date() } },
      { new: true }
    ).lean();
    if (!incident) return res.status(404).json({ error: "Not found" });

    // Send inbox email to all management + admin
    const staff = await User.find({ role: { $in: ["management", "admin"] } }, "_id").lean();
    const ts = Date.now();
    const incRef = `INC-${incident._id.toString().slice(-6).toUpperCase()}`;
    for (const u of staff) {
      await Message.create({
        user_id: u._id.toString(),
        id: `reopen-req-${incident._id}-${ts}`,
        from: "Dispatch System",
        subject: `Reopen Request: ${incident.title}`,
        preview: `A customer wants to reopen ${incRef}. Reason: ${reason.slice(0, 80)}`,
        body: `A customer has requested to reopen incident ${incRef} — "${incident.title}".\n\nReason: ${reason}\n\nPlease review this incident and accept or reject the request from the incident panel.`,
        timestamp: "just now", createdAt: ts, unread: true, starred: false, role: "admin",
      });
    }

    res.json({ incident });
  } catch (err) {
    res.status(500).json({ error: "Failed to submit reopen request" });
  }
});

app.patch("/api/incidents/:id/reopen-request/respond", async (req, res) => {
  try {
    const { accepted, response_message, responder_id } = req.body;
    if (accepted === undefined) return res.status(400).json({ error: "Missing accepted field" });

    const incident = await Incident.findById(req.params.id).lean();
    if (!incident) return res.status(404).json({ error: "Not found" });

    const update = accepted
      ? { status: "open", reopen_request: { pending: false, reason: "", requested_by: null, requested_at: null }, updated_at: Date.now() }
      : { reopen_request: { pending: false, reason: "", requested_by: null, requested_at: null }, updated_at: Date.now() };

    const updated = await Incident.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    const incRef  = `INC-${incident._id.toString().slice(-6).toUpperCase()}`;
    const ts      = Date.now();

    // Send inbox email back to customer
    if (incident.reopen_request?.requested_by) {
      await Message.create({
        user_id: incident.reopen_request.requested_by,
        id: `reopen-resp-${incident._id}-${ts}`,
        from: "Dispatch System",
        subject: accepted
          ? `Reopen Approved: ${incident.title}`
          : `Reopen Declined: ${incident.title}`,
        preview: response_message?.slice(0, 100) || (accepted ? "Your reopen request was approved." : "Your reopen request was declined."),
        body: response_message || (accepted
          ? `Your request to reopen incident ${incRef} has been approved. The incident is now open again.`
          : `Your request to reopen incident ${incRef} has been declined.`),
        timestamp: "just now", createdAt: ts, unread: true, starred: false, role: "admin",
      });
    }

    res.json({ incident: updated });
  } catch (err) {
    res.status(500).json({ error: "Failed to respond to reopen request" });
  }
});

// ── Health check ──────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok" }));

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));