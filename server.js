import express from "express";
import admin from "firebase-admin";
import cors from "cors";
import B2 from "backblaze-b2";
import mongoose from "mongoose";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================================
// 1. SETUP & CONNECTIONS
// ============================================================================

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/chat_app";
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch(err => console.error("❌ MongoDB Connection Error:", err));

// Schemas
const MessageSchema = new mongoose.Schema({
  docId: { type: String, required: true, unique: true },
  text: String,
  senderId: String,
  timestamp: Number,
  seen: { type: Boolean, default: false },
  status: { type: String, default: "sent" },
  mediaUrl: String,
  mediaType: String,
  replyToMessageId: String,
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

// Socket Setup
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// ============================================================================
// 2. SOCKET LOGIC (THE BRIDGE 🌉)
// ============================================================================
io.on('connection', (socket) => {
  console.log(`🔌 Socket Connected: ${socket.id}`);

  // 1. Join Room
  socket.on('join', async ({ userId, roomId }) => {
    try {
      socket.join(roomId);
      socket.data.userId = userId; // Critical for Smart Disconnect
      socket.userId = userId;

      await User.findOneAndUpdate({ userId }, { isOnline: true, lastSeen: Date.now() }, { upsert: true });
      socket.to(roomId).emit('presence_update', { userId, isOnline: true });

      // Check who else is here
      const sockets = await io.in(roomId).fetchSockets();
      const onlineUsers = sockets.map(s => s.data.userId).filter(id => id && id !== userId);

      if (onlineUsers.length > 0) {
          onlineUsers.forEach(partnerId => {
               socket.emit('presence_update', { userId: partnerId, isOnline: true });
          });
      }
    } catch (e) { console.error("Join Error:", e); }
  });

  // --- 📨 SEND MESSAGE (BRIDGE ENABLED) ---
  socket.on('send_message', async (data) => {
    try {
      console.log(`📨 Socket Message from ${data.senderId}`);

      // 1. Save to MongoDB (The New Way)
      const newMsg = new Message(data);
      await newMsg.save();

      // 2. Emit to Socket Users (You)
      io.to(data.roomId).emit('new_message', data);
      socket.emit('message_sent', { docId: data.docId, status: 'sent' });

      // 3. 🌉 THE BRIDGE: Write to Firestore (For Her)
      // This ensures her old app sees the message in the database listener
      try {
        await admin.firestore()
          .collection('rooms')
          .doc(data.roomId || 'room1')
          .collection('messages')
          .doc(data.docId) // Use same ID to prevent duplicates later
          .set({
             ...data,
             timestamp: admin.firestore.FieldValue.serverTimestamp() // Use Server Time for sorting
          });
        console.log("🌉 Bridged message to Firestore for compatibility");
      } catch (fsError) {
        console.error("❌ Firestore Bridge Failed:", fsError);
      }

      // 4. Send Notification
      const receiverId = data.senderId === "user1" ? "user2" : "user1";
      await sendFCM(data.senderId, receiverId, data.text || "New Message");

    } catch (e) {
      console.error("Socket Save Error:", e);
    }
  });

  // 3. Typing
  socket.on('typing', ({ roomId, isTyping }) => {
    socket.to(roomId).emit('partner_typing', { userId: socket.userId, isTyping });
  });

  // 4. Disconnect
  socket.on('disconnect', async () => {
    if (socket.userId) {
      const sockets = await io.fetchSockets();
      const remainingConnections = sockets.filter(s => s.data.userId === socket.userId);
      if (remainingConnections.length > 0) return;

      await User.findOneAndUpdate({ userId: socket.userId }, { isOnline: false, lastSeen: Date.now() });
      io.emit('presence_update', { userId: socket.userId, isOnline: false });
    }
  });
});

// ============================================================================
// 3. CONFIGURATION (FIREBASE & B2)
// ============================================================================

const serviceAccount = JSON.parse(
  Buffer.from(process.env.SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

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
// 4. HELPER FUNCTIONS
// ============================================================================

async function sendFCM(senderId, receiverId, messageText) {
  try {
    const tokenDoc = await admin.firestore().collection("fcm_tokens").doc(receiverId).get();
    
    if (!tokenDoc.exists || !tokenDoc.data().token) {
      console.log(`⚠️ No FCM token for ${receiverId}`);
      return;
    }

    const payload = {
      token: tokenDoc.data().token,
      data: {
        senderId: senderId,
        message: messageText,
        timestamp: Date.now().toString(),
        type: "chat_message",
      },
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

// ============================================================================
// 5. API ROUTES (ALL ROUTES INCLUDED)
// ============================================================================

app.get("/", (req, res) => {
  res.send("Chat Server Active (Hybrid Bridge Mode) 🌉");
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
      data: {
        type: "incoming_call",
        callerId, calleeId, callType, callId,
        callerName: callerId === "user1" ? "Shubham" : "Prachiti"
      },
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
    // 1. Firebase (Legacy)
    await admin.firestore().collection("fcm_tokens").doc(userId).set({ 
      token, updatedAt: admin.firestore.FieldValue.serverTimestamp() 
    });
    
    // 2. Mongo (Future)
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
    b2Authorized: b2Authorized,
    mongoConnected: mongoose.connection.readyState === 1
  });
});

// ============================================================================
// 6. SERVER START
// ============================================================================

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🔥 Hybrid Bridge Server running on port ${PORT}`);
  console.log(`🚀 Ready for Firebase (Current) AND Socket.io (Future)`);
});