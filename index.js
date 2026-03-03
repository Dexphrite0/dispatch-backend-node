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

// Helper: upload base64 image to Cloudinary, return URL
async function uploadImage(base64, folder = "dispatch") {
  if (!base64) return null;
  // Already a URL (already migrated) — return as-is
  if (base64.startsWith("http")) return base64;
  const result = await cloudinary.uploader.upload(base64, { folder, resource_type: "image" });
  return result.secure_url;
}

const app = express();
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json({ limit: "20mb" }));

// ── Ably REST client ──────────────────────────────────────────────────────
const ably = new Ably.Rest({ key: process.env.ABLY_API_KEY });

// ── MongoDB connection ────────────────────────────────────────────────────
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
  created_by:  { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  assigned_to: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  comments: [{
    content: String, author_id: mongoose.Schema.Types.ObjectId,
    author_name: String, created_at: { type: Date, default: Date.now },
  }],
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});
const Incident = mongoose.model("Incident", IncidentSchema);

// ── Timestamp helpers ─────────────────────────────────────────────────────
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

// ── Notify all conversation partners about online status via Ably ─────────
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
  res.json(users.map(u => ({
    _id: u._id,
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    role: u.role,
    profilePic: u.profilePic?.startsWith('http') ? u.profilePic : null,
  })));
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
    await Message.create({
      user_id: uid,
      id: `management-email-${ts}`,
      from,                          // "Management Team"
      subject,
      preview: body.slice(0, 100),
      body,
      timestamp: "just now",
      createdAt: ts,
      unread: true,
      starred: false,
      role: "management",            // 👈 labeled as management (not admin)
      isManagement: true             // 👈 management flag
    });
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
    return { conversation_id: conv._id.toString(), other_user: { _id: otherId, firstName: other.firstName, lastName: other.lastName, role: other.role, profilePic: other.profilePic?.startsWith('http') ? other.profilePic : null, 
      online: other.online && other.last_seen && (Date.now() - other.last_seen < 120000) ? true : (other.online && !other.last_seen ? true : false),
last_seen: other.last_seen },
       last_message: conv.last_message, last_message_time: conv.last_message_time, last_message_sender: conv.last_message_sender, unread };
  }).filter(Boolean);
  res.json(result);
});

app.get("/api/chat/conversation/:convId/messages", async (req, res) => {
  const msgs = await ChatMessage.find({ conversation_id: req.params.convId }).sort({ timestamp: 1 });
  res.json(msgs.map(m => ({ _id: m._id.toString(), conversation_id: m.conversation_id, sender_id: m.sender_id, content: m.content, timestamp: m.timestamp, read: m.read, deleted: m.deleted, reply_to: m.reply_to })));
});

app.get("/api/incidents/user/:userId", async (req, res) => {
  try {
    const incidents = await Incident.find({ created_by: req.params.userId })
      .sort({ created_at: -1 })
      .populate("assigned_to", "firstName lastName")
      .lean();
    res.json(incidents);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch incidents" });
  }
});

// GET — all incidents (management/admin view)
app.get("/api/incidents", async (req, res) => {
  try {
    const { status, priority, assigned_to } = req.query;
    const filter = {};
    if (status)      filter.status      = status;
    if (priority)    filter.priority    = priority;
    if (assigned_to) filter.assigned_to = assigned_to;

    const incidents = await Incident.find(filter)
      .sort({ created_at: -1 })
      .populate("created_by",  "firstName lastName role profilePic")
      .populate("assigned_to", "firstName lastName role profilePic")
      .lean();
    res.json(incidents);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch incidents" });
  }
});

// POST — create a new incident
app.post("/api/incidents", async (req, res) => {
  try {
    const { title, description, priority, category, created_by } = req.body;
    if (!title || !description || !created_by) {
      return res.status(400).json({ error: "title, description and created_by are required" });
    }
    const incident = await Incident.create({ title, description, priority, category, created_by });
    const populated = await incident.populate("assigned_to", "firstName lastName");
    res.json({ incident: populated });
  } catch (err) {
    res.status(500).json({ error: "Failed to create incident" });
  }
});

// PATCH — update incident status
app.patch("/api/incidents/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ["open", "in_progress", "resolved", "closed"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    const incident = await Incident.findByIdAndUpdate(
      req.params.id,
      { status, updated_at: Date.now() },
      { new: true }
    ).populate("assigned_to", "firstName lastName").lean();
    if (!incident) return res.status(404).json({ error: "Incident not found" });
    res.json({ incident });
  } catch (err) {
    res.status(500).json({ error: "Failed to update status" });
  }
});

// PATCH — assign incident to a professional (management/admin)
app.patch("/api/incidents/:id/assign", async (req, res) => {
  try {
    const { assigned_to } = req.body;
    const incident = await Incident.findByIdAndUpdate(
      req.params.id,
      { assigned_to, status: "in_progress", updated_at: Date.now() },
      { new: true }
    )
      .populate("created_by",  "firstName lastName role profilePic")
      .populate("assigned_to", "firstName lastName role profilePic")
      .lean();
    if (!incident) return res.status(404).json({ error: "Incident not found" });
    res.json({ incident });
  } catch (err) {
    res.status(500).json({ error: "Failed to assign incident" });
  }
});

// GET — comments for an incident
app.get("/api/incidents/:id/comments", async (req, res) => {
  try {
    const incident = await Incident.findById(req.params.id).select("comments").lean();
    if (!incident) return res.status(404).json({ error: "Incident not found" });
    res.json(incident.comments || []);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch comments" });
  }
});

// POST — add a comment to an incident
app.post("/api/incidents/:id/comments", async (req, res) => {
  try {
    const { content, author_id } = req.body;
    if (!content || !author_id) {
      return res.status(400).json({ error: "content and author_id are required" });
    }
    // get author name
    const author = await User.findById(author_id).select("firstName lastName").lean();
    const author_name = author ? `${author.firstName} ${author.lastName}` : "Unknown";

    const newComment = { content, author_id, author_name, created_at: new Date() };
    const incident = await Incident.findByIdAndUpdate(
      req.params.id,
      { $push: { comments: newComment }, updated_at: Date.now() },
      { new: true }
    ).lean();
    if (!incident) return res.status(404).json({ error: "Incident not found" });

    const added = incident.comments[incident.comments.length - 1];
    res.json({ comment: added });
  } catch (err) {
    res.status(500).json({ error: "Failed to add comment" });
  }
});

// DELETE — delete an incident (admin only)
app.delete("/api/incidents/:id", async (req, res) => {
  try {
    await Incident.findByIdAndDelete(req.params.id);
    res.json({ message: "Incident deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete incident" });
  }
});

// ── Health check ──────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok" }));

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));