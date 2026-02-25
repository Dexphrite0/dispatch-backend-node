require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const { WebSocketServer } = require("ws");
const http = require("http");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors({ origin: "*", credentials: true }));
app.use(express.json({ limit: "20mb" }));

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

// ── WebSocket connections map ─────────────────────────────────────────────
const connections = new Map(); // userId -> ws

async function sendOnlineStatus(userId, online, last_seen) {
  const convs = await Conversation.find({ participants: userId });
  const payload = JSON.stringify({ type: "online_status", user_id: userId, online, last_seen });
  for (const conv of convs) {
    for (const pid of conv.participants) {
      if (pid !== userId && connections.has(pid)) {
        connections.get(pid).send(payload);
      }
    }
  }
}

async function processWSEvent(senderId, text, ws) {
  let ev;
  try { ev = JSON.parse(text); } catch { return; }

  switch (ev.type) {
    case "ping": ws.send(JSON.stringify({ type: "pong" })); break;
    case "message":     await wsSendMessage(senderId, ev); break;
    case "typing":      wsForwardTyping(senderId, ev, true); break;
    case "stop_typing": wsForwardTyping(senderId, ev, false); break;
    case "read":        await wsReadReceipt(senderId, ev); break;
    case "delete":      await wsDeleteMessage(senderId, ev); break;
  }
}

async function wsSendMessage(senderId, ev) {
  const { to, content, temp_id, reply_to } = ev;
  if (!to || !content?.trim()) return;
  const timestamp = Date.now();

  let conv = await Conversation.findOne({ participants: { $all: [senderId, to], $size: 2 } });
  if (!conv) {
    conv = await Conversation.create({ participants: [senderId, to], last_message: content, last_message_time: timestamp, last_message_sender: senderId, unread: {} });
  }
  const convId = conv._id.toString();

  const msg = await ChatMessage.create({ conversation_id: convId, sender_id: senderId, content, timestamp, read: false, deleted: false, reply_to: reply_to || null });
  const msgId = msg._id.toString();

  await Conversation.updateOne(
    { _id: conv._id },
    { $set: { last_message: content, last_message_time: timestamp, last_message_sender: senderId }, $inc: { [`unread.${to}`]: 1 } }
  );

  const msgData = { _id: msgId, conversation_id: convId, sender_id: senderId, content, timestamp, read: false, deleted: false, reply_to: reply_to || null };

  if (connections.has(senderId)) connections.get(senderId).send(JSON.stringify({ type: "sent", data: msgData, temp_id }));
  if (connections.has(to))       connections.get(to).send(JSON.stringify({ type: "message", data: msgData }));
}

function wsForwardTyping(senderId, ev, isTyping) {
  const { to } = ev;
  if (!to || !connections.has(to)) return;
  connections.get(to).send(JSON.stringify({ type: isTyping ? "typing" : "stop_typing", from: senderId }));
}

async function wsReadReceipt(readerId, ev) {
  const { conversation_id } = ev;
  if (!conversation_id) return;
  await ChatMessage.updateMany({ conversation_id, sender_id: { $ne: readerId }, read: false, deleted: false }, { $set: { read: true } });
  await Conversation.updateOne({ _id: conversation_id }, { $set: { [`unread.${readerId}`]: 0 } });

  const conv = await Conversation.findById(conversation_id);
  if (!conv) return;
  const payload = JSON.stringify({ type: "read", conversation_id, reader_id: readerId });
  for (const pid of conv.participants) {
    if (pid !== readerId && connections.has(pid)) connections.get(pid).send(payload);
  }
}

async function wsDeleteMessage(userId, ev) {
  const { message_id, conversation_id } = ev;
  if (!message_id || !conversation_id) return;
  const result = await ChatMessage.updateOne({ _id: message_id, sender_id: userId }, { $set: { deleted: true, content: "This message was deleted" } });
  if (!result.modifiedCount) return;

  const payload = JSON.stringify({ type: "deleted", message_id, conversation_id });
  const conv = await Conversation.findById(conversation_id);
  if (!conv) return;
  for (const pid of conv.participants) {
    if (connections.has(pid)) connections.get(pid).send(payload);
  }
}

// ── WebSocket upgrade ─────────────────────────────────────────────────────
wss.on("connection", async (ws, req) => {
  const userId = req.url.split("/ws/")[1];
  if (!userId) return ws.close();

  connections.set(userId, ws);
  await User.updateOne({ _id: userId }, { $set: { online: true } }).catch(() => {});
  await sendOnlineStatus(userId, true, null);

  const heartbeat = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, 25000);

  ws.on("message", (data) => processWSEvent(userId, data.toString(), ws));
  ws.on("close", async () => {
    clearInterval(heartbeat);
    connections.delete(userId);
    const now = Date.now();
    await User.updateOne({ _id: userId }, { $set: { online: false, last_seen: now } }).catch(() => {});
    await sendOnlineStatus(userId, false, now);
  });
  ws.on("error", () => {});
});

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

// ── User ──────────────────────────────────────────────────────────────────
app.get("/api/user/:id", async (req, res) => {
  const user = await User.findById(req.params.id).catch(() => null);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ _id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email, role: user.role, profilePic: user.profilePic, backgroundImage: user.backgroundImage, coverImage: user.coverImage, phone: user.phone, location: user.location, website: user.website, bio: user.bio, online: user.online || false, last_seen: user.last_seen, createdAt: formatTimestamp(user.createdAt), createdAtRelative: formatRelative(user.createdAt) });
});

app.post("/api/user/:id/profile-pic", async (req, res) => {
  await User.updateOne({ _id: req.params.id }, { $set: { profilePic: req.body.profilePic } });
  res.json({ message: "Profile pic saved" });
});

app.post("/api/user/:id/background", async (req, res) => {
  await User.updateOne({ _id: req.params.id }, { $set: { backgroundImage: req.body.backgroundImage } });
  res.json({ message: "Background image saved" });
});

app.post("/api/user/:id/cover-image", async (req, res) => {
  await User.updateOne({ _id: req.params.id }, { $set: { coverImage: req.body.coverImage } });
  res.json({ message: "Cover image saved" });
});

app.post("/api/user/:id/profile", async (req, res) => {
  const fields = {};
  ["firstName","lastName","bio","phone","location","website","role"].forEach(k => { if (req.body[k] !== undefined) fields[k] = req.body[k]; });
  await User.updateOne({ _id: req.params.id }, { $set: fields });
  res.json({ message: "Profile updated" });
});

app.get("/api/users", async (req, res) => {
  const users = await User.find({}, "_id firstName lastName email role");
  res.json(users.map(u => ({ _id: u._id, firstName: u.firstName, lastName: u.lastName, email: u.email, role: u.role })));
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

// ── Chat HTTP ─────────────────────────────────────────────────────────────
app.post("/api/chat/send", async (req, res) => {
  const { to, content, sender_id, reply_to } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: "Empty message" });
  const timestamp = Date.now();

  let conv = await Conversation.findOne({ participants: { $all: [sender_id, to], $size: 2 } });
  if (!conv) conv = await Conversation.create({ participants: [sender_id, to], last_message: content, last_message_time: timestamp, last_message_sender: sender_id, unread: {} });
  const convId = conv._id.toString();

  const msg = await ChatMessage.create({ conversation_id: convId, sender_id, content, timestamp, read: false, deleted: false, reply_to: reply_to || null });
  const msgId = msg._id.toString();

  await Conversation.updateOne({ _id: conv._id }, { $set: { last_message: content, last_message_time: timestamp, last_message_sender: sender_id }, $inc: { [`unread.${to}`]: 1 } });

  const msgData = { _id: msgId, conversation_id: convId, sender_id, content, timestamp, read: false, deleted: false, reply_to: reply_to || null };
  if (connections.has(to)) connections.get(to).send(JSON.stringify({ type: "message", data: msgData }));

  res.json({ message: msgData });
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
  const result = [];
  for (const conv of convs) {
    const otherId = conv.participants.find(p => p !== uid);
    if (!otherId) continue;
    const other = await User.findById(otherId).catch(() => null);
    if (!other) continue;
    const unread = conv.unread?.[uid] || 0;
    result.push({ conversation_id: conv._id.toString(), other_user: { _id: otherId, firstName: other.firstName, lastName: other.lastName, role: other.role, profilePic: other.profilePic, online: other.online || false, last_seen: other.last_seen }, last_message: conv.last_message, last_message_time: conv.last_message_time, last_message_sender: conv.last_message_sender, unread });
  }
  res.json(result);
});

app.get("/api/chat/conversation/:convId/messages", async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const before = req.query.before ? parseInt(req.query.before) : null;
  const query = { conversation_id: req.params.convId };
  if (before) query.timestamp = { $lt: before };
  const msgs = await ChatMessage.find(query).sort({ timestamp: -1 }).limit(limit);
  msgs.reverse();
  res.json(msgs.map(m => ({ _id: m._id.toString(), conversation_id: m.conversation_id, sender_id: m.sender_id, content: m.content, timestamp: m.timestamp, read: m.read, deleted: m.deleted, reply_to: m.reply_to })));
});

// ── Health check ──────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok" }));

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));