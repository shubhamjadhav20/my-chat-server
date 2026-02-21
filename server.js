import express from "express";
import admin from "firebase-admin";
import cors from "cors";
import B2 from "backblaze-b2";
import mongoose from "mongoose";
import { createServer } from "http";
import { Server } from "socket.io";
import sharp from "sharp";           // npm install sharp
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================================
// THUMBNAIL CACHE DIRECTORY
// Thumbnails are stored on Render's ephemeral disk at /tmp/thumb_cache.
// They survive for the lifetime of the dyno (days/weeks typically).
// On cold restart they're regenerated on first request — that's fine.
// ============================================================================
const THUMB_DIR = path.join("/tmp", "thumb_cache");
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

// ============================================================================
// 1. HYBRID SETUP: DATABASE & SOCKETS
// ============================================================================

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/chat_app";
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch(err => console.error("❌ MongoDB Connection Error:", err));

const MessageSchema = new mongoose.Schema({
  docId: { type: String, required: true, unique: true },
  text: String,
  senderId: String,
  timestamp: Number,
  seen: { type: Boolean, default: false },
  status: { type: String, default: "sent" },
  mediaUrl: String,
  mediaType: String,
  viewOnce: { type: Boolean, default: false },
  replyToMessageId: String,
  replyToText: String,
  replyToSender: String,
  replyToMediaUrl: String,
  replyToMediaType: String,
  edited: { type: Boolean, default: false },
  editedAt: Number,
  originalText: String,
  localId: String,
  roomId: { type: String, default: "room1" }
});

const UserSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  fcmToken: String,
  isOnline: Boolean,
  lastSeen: Number
});

const Message = mongoose.model('Message', MessageSchema);
const User = mongoose.model('User', UserSchema);

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// ============================================================================
// SOCKET.IO LOGIC
// ============================================================================
io.on('connection', (socket) => {
  console.log(`🔌 Socket Connected: ${socket.id}`);

  socket.on('join', async ({ userId, roomId }) => {
    try {
      socket.join(roomId);
      socket.data.userId = userId;
      socket.userId = userId;
      console.log(`👤 User ${userId} joined room ${roomId}`);
      await User.findOneAndUpdate({ userId }, { isOnline: true, lastSeen: Date.now() }, { upsert: true });
      socket.to(roomId).emit('presence_update', { userId, isOnline: true });
      const sockets = await io.in(roomId).fetchSockets();
      const onlineUsers = sockets.map(s => s.data.userId).filter(id => id && id !== userId);
      if (onlineUsers.length > 0) {
        onlineUsers.forEach(partnerId => {
          socket.emit('presence_update', { userId: partnerId, isOnline: true });
        });
      }
    } catch (e) { console.error("Join Error:", e); }
  });

  socket.on('send_message', async (data) => {
    try {
      console.log(`📨 Socket Message from ${data.senderId}`);
      const newMsg = new Message(data);
      await newMsg.save();
      await Message.findOneAndUpdate({ docId: data.docId }, { status: 'delivered' });
      io.to(data.roomId).emit('new_message', data);
      socket.emit('message_sent', { docId: data.docId, localId: data.localId, status: 'sent' });
      try {
        await admin.firestore()
          .collection('rooms').doc(data.roomId || 'room1')
          .collection('messages').doc(data.docId)
          .set({ ...data, status: 'delivered', timestamp: admin.firestore.FieldValue.serverTimestamp() });
        console.log("✅ Bridged to Firestore");
      } catch (e) { console.error("Bridge Error:", e.message); }
      const receiverId = data.senderId === "user1" ? "user2" : "user1";
      await sendFCM(data.senderId, receiverId, data.text || "New Message");
    } catch (e) { console.error("Socket Save Error:", e); }
  });

  socket.on('update_status', async ({ docId, status, roomId }) => {
    console.log(`🔄 Status Update: ${docId} -> ${status}`);
    await Message.findOneAndUpdate({ docId }, { status, seen: status === 'seen' });
    io.to(roomId).emit('status_updated', { docId, status });
    try {
      await admin.firestore().collection('rooms').doc(roomId)
        .collection('messages').doc(docId).update({ status, seen: status === 'seen' });
    } catch(e) {}
  });

  socket.on('typing', ({ roomId, isTyping }) => {
    socket.to(roomId).emit('partner_typing', { userId: socket.userId, isTyping });
  });

  socket.on('disconnect', async () => {
    console.log(`❌ Disconnected: ${socket.id} (${socket.userId})`);
    if (socket.userId) {
      const sockets = await io.fetchSockets();
      const remaining = sockets.filter(s => s.data.userId === socket.userId && s.id !== socket.id);
      if (remaining.length > 0) return;
      await User.findOneAndUpdate({ userId: socket.userId }, { isOnline: false, lastSeen: Date.now() });
      io.emit('presence_update', { userId: socket.userId, isOnline: false });
      console.log(`🔴 User ${socket.userId} is now truly OFFLINE.`);
    }
  });
});

// ============================================================================
// 2. FIREBASE & B2 SETUP
// ============================================================================

const serviceAccount = JSON.parse(
  Buffer.from(process.env.SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const b2 = new B2({
  applicationKeyId: process.env.B2_KEY_ID,
  applicationKey: process.env.B2_APPLICATION_KEY,
});

let b2Authorized = false;
let authorizationData = null;

async function authorizeB2() {
  try {
    const response = await b2.authorize();
    b2Authorized = true;
    authorizationData = response.data;
    console.log("✅ Backblaze B2 authorized successfully");
    return true;
  } catch (error) {
    console.error("❌ Failed to authorize B2:", error.message);
    return false;
  }
}
authorizeB2();

// ============================================================================
// 3. SHARED HELPERS
// ============================================================================

async function sendFCM(senderId, receiverId, messageText) {
  try {
    const tokenDoc = await admin.firestore().collection("fcm_tokens").doc(receiverId).get();
    if (!tokenDoc.exists || !tokenDoc.data().token) return;
    const payload = {
      token: tokenDoc.data().token,
      data: { senderId, message: messageText, timestamp: Date.now().toString(), type: "chat_message" },
      android: { priority: "high" },
    };
    await admin.messaging().send(payload);
    console.log(`✅ Notification sent to ${receiverId}`);
  } catch (error) {
    console.error(`⚠️ FCM Failed: ${error.message}`);
    if (error.code === 'messaging/invalid-registration-token' ||
        error.code === 'messaging/registration-token-not-registered') {
      await admin.firestore().collection("fcm_tokens").doc(receiverId).delete();
    }
  }
}

// Download a file from B2 using a short-lived signed URL (internal server use only)
async function downloadFromB2(fileName) {
  if (!b2Authorized) await authorizeB2();
  const downloadAuth = await b2.getDownloadAuthorization({
    bucketId: process.env.B2_BUCKET_ID,
    fileNamePrefix: fileName,
    validDurationInSeconds: 300, // 5 min — only needed for the duration of download
  });
  const signedUrl = `${authorizationData.downloadUrl}/file/${process.env.B2_BUCKET_NAME}/${fileName}?Authorization=${downloadAuth.data.authorizationToken}`;
  const response = await fetch(signedUrl);
  if (!response.ok) throw new Error(`B2 download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// ============================================================================
// 4. THUMBNAIL ENDPOINT  🖼️ → saves B2 bandwidth
//
// GET /api/thumbnail?file=chat_media/xyz.jpg&size=300
//
// Flow:
//   1. Check /tmp/thumb_cache — if hit, serve directly (zero B2 calls)
//   2. Miss: download original from B2, resize with sharp, save to cache, serve
//
// Result: Each unique image hits B2 exactly ONCE ever (per dyno lifetime).
// The grid shows 300×300 JPEGs (~15–30KB) instead of 3MB originals.
// Full-res is only downloaded by the full-screen viewer via the normal
// /getSignedUrl route — and Coil caches that on device too.
// ============================================================================
app.get("/api/thumbnail", async (req, res) => {
  try {
    const { file, size = "300" } = req.query;
    if (!file) return res.status(400).json({ error: "file param required" });

    const thumbSize = Math.min(Math.max(parseInt(size) || 300, 50), 600); // clamp 50–600px
    const cacheKey = `${file.replace(/[^a-zA-Z0-9]/g, "_")}_${thumbSize}.jpg`;
    const cachePath = path.join(THUMB_DIR, cacheKey);

    // ── Cache hit: serve from disk ─────────────────────────────────────────
    if (fs.existsSync(cachePath)) {
      console.log(`🖼️ Thumbnail cache hit: ${cacheKey}`);
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=31536000"); // 1 year browser cache
      return res.sendFile(cachePath);
    }

    // ── Cache miss: download from B2, resize, cache, serve ────────────────
    console.log(`📥 Generating thumbnail for: ${file}`);
    const originalBuffer = await downloadFromB2(file);

    const thumbBuffer = await sharp(originalBuffer)
      .resize(thumbSize, thumbSize, {
        fit: "cover",        // crop to square like the grid cells
        position: "centre",
      })
      .jpeg({ quality: 80, progressive: true })
      .toBuffer();

    // Save to disk cache asynchronously — don't block the response
    fs.writeFile(cachePath, thumbBuffer, (err) => {
      if (err) console.error(`Failed to cache thumbnail: ${err.message}`);
    });

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000");
    res.send(thumbBuffer);

  } catch (error) {
    console.error(`Thumbnail error for ${req.query.file}: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// 5. API ROUTES
// ============================================================================

app.get("/", (req, res) => {
  res.send("Chat Server Active (Hybrid Mode: Socket + REST) 🚀");
});

app.get("/api/messages", async (req, res) => {
  try {
    const { roomId, beforeTimestamp, limit } = req.query;
    const query = { roomId: roomId || "room1" };
    if (beforeTimestamp) query.timestamp = { $lt: Number(beforeTimestamp) };
    const messages = await Message.find(query).sort({ timestamp: -1 }).limit(Number(limit) || 30);
    res.json(messages);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/media", async (req, res) => {
  try {
    const { roomId } = req.query;
    const mediaMessages = await Message.find({
      roomId: roomId || "room1",
      mediaUrl: { $exists: true, $ne: null, $ne: "" }
    })
      .sort({ timestamp: -1 })
      .select("docId senderId timestamp seen status mediaUrl mediaType viewOnce replyToMessageId replyToText replyToSender text");
    res.json(mediaMessages);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/messages/search", async (req, res) => {
  try {
    const { roomId, q } = req.query;
    if (!q || q.length < 2) return res.json([]);
    const results = await Message.find({
      roomId: roomId || "room1",
      text: { $regex: q, $options: "i" }
    }).sort({ timestamp: -1 }).limit(50);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Batch signed URLs — one round-trip for many files
app.post("/api/batch-signed-urls", async (req, res) => {
  try {
    const { fileNames } = req.body;
    if (!Array.isArray(fileNames) || fileNames.length === 0) {
      return res.status(400).json({ error: "fileNames array required" });
    }
    if (!b2Authorized) await authorizeB2();
    const results = await Promise.all(
      fileNames.map(async (fileName) => {
        try {
          const downloadAuth = await b2.getDownloadAuthorization({
            bucketId: process.env.B2_BUCKET_ID,
            fileNamePrefix: fileName,
            validDurationInSeconds: 86400,
          });
          const signedUrl = `${authorizationData.downloadUrl}/file/${process.env.B2_BUCKET_NAME}/${fileName}?Authorization=${downloadAuth.data.authorizationToken}`;
          return { fileName, signedUrl };
        } catch (e) {
          console.error(`Failed URL for ${fileName}: ${e.message}`);
          return { fileName, signedUrl: null };
        }
      })
    );
    const response = {};
    results.forEach(({ fileName, signedUrl }) => {
      if (signedUrl) response[fileName] = signedUrl;
    });
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/messages/edit", async (req, res) => {
  try {
    const { docId, newText, roomId } = req.body;
    if (!docId || !newText) return res.status(400).json({ error: "Missing docId or newText" });
    const msg = await Message.findOne({ docId });
    if (!msg) return res.status(404).json({ error: "Message not found" });
    await Message.findOneAndUpdate({ docId }, { text: newText, edited: true, editedAt: Date.now(), originalText: msg.text });
    try {
      await admin.firestore().collection('rooms').doc(roomId || 'room1')
        .collection('messages').doc(docId)
        .update({ text: newText, edited: true, editedAt: Date.now(), originalText: msg.text });
    } catch(e) {}
    io.to(roomId || 'room1').emit('message_edited', { docId, newText, editedAt: Date.now() });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/messages/clear", async (req, res) => {
  try {
    const { roomId } = req.body;
    await Message.deleteMany({ roomId: roomId || 'room1' });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/getUploadAuth", async (req, res) => {
  try {
    const { userId, fileName, fileType } = req.body;
    if (!userId || !fileName) return res.status(400).json({ success: false, error: "Missing data" });
    try {
      const uploadUrlResponse = await b2.getUploadUrl({ bucketId: process.env.B2_BUCKET_ID });
      return res.json({
        success: true,
        uploadUrl: uploadUrlResponse.data.uploadUrl,
        authorizationToken: uploadUrlResponse.data.authorizationToken,
        bucketName: process.env.B2_BUCKET_NAME,
      });
    } catch (uploadError) {
      if (uploadError.status === 401 || uploadError.data?.code === 'expired_auth_token') {
        await authorizeB2();
        const retry = await b2.getUploadUrl({ bucketId: process.env.B2_BUCKET_ID });
        return res.json({
          success: true,
          uploadUrl: retry.data.uploadUrl,
          authorizationToken: retry.data.authorizationToken,
          bucketName: process.env.B2_BUCKET_NAME,
        });
      }
      throw uploadError;
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/sendChatMessage", async (req, res) => {
  try {
    const { senderId, message } = req.body;
    const receiverId = senderId === "user1" ? "user2" : "user1";
    await sendFCM(senderId, receiverId, message);
    return res.status(200).json({ success: true, message: "Processed" });
  } catch (error) {
    return res.status(200).json({ success: true, error: error.message });
  }
});

app.post("/sendCallNotification", async (req, res) => {
  try {
    const { callerId, calleeId, callType, callId } = req.body;
    const tokenDoc = await admin.firestore().collection("fcm_tokens").doc(calleeId).get();
    if (!tokenDoc.exists) return res.json({ success: false, error: "No token" });
    const payload = {
      token: tokenDoc.data().token,
      data: { type: "incoming_call", callerId, calleeId, callType, callId,
              callerName: callerId === "user1" ? "Shubham" : "Prachiti" },
      android: { priority: "high" }
    };
    await admin.messaging().send(payload);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/testNotification", async (req, res) => {
  try {
    const { token, title, message } = req.body;
    if (!token) return res.status(400).json({ success: false, error: "Token required" });
    const payload = {
      token,
      notification: { title: title || "Test", body: message || "Hello" },
      android: { priority: "high" }
    };
    const response = await admin.messaging().send(payload);
    res.json({ success: true, messageId: response });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/saveFCMToken", async (req, res) => {
  try {
    const { userId, token } = req.body;
    await admin.firestore().collection("fcm_tokens").doc(userId).set({
      token, updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    if (mongoose.connection.readyState === 1) {
      await User.findOneAndUpdate({ userId }, { fcmToken: token }, { upsert: true });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/getSignedUrl", async (req, res) => {
  try {
    const { fileName } = req.body;
    if (!fileName) return res.status(400).json({ success: false, error: "fileName required" });
    if (!b2Authorized) await authorizeB2();
    const downloadAuth = await b2.getDownloadAuthorization({
      bucketId: process.env.B2_BUCKET_ID,
      fileNamePrefix: fileName,
      validDurationInSeconds: 86400,
    });
    const signedUrl = `${authorizationData.downloadUrl}/file/${process.env.B2_BUCKET_NAME}/${fileName}?Authorization=${downloadAuth.data.authorizationToken}`;
    res.json({ success: true, signedUrl });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    b2Authorized,
    mongoConnected: mongoose.connection.readyState === 1,
    thumbCacheFiles: fs.readdirSync(THUMB_DIR).length
  });
});

// ============================================================================
// 6. SERVER START
// ============================================================================
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🔥 Hybrid Server running on port ${PORT}`);
});
