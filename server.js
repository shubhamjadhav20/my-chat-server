import express from "express";
import admin from "firebase-admin";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// Railway loads JSON from env
const serviceAccount = JSON.parse(
  Buffer.from(process.env.SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Default test route
app.get("/", (req, res) => {
  res.send("Chat Server is running on Railway 🚀");
});

// ============================================================================
// FIXED: Send chat message notification
// ============================================================================
app.post("/sendChatMessage", async (req, res) => {
  try {
    const { senderId, message } = req.body;
    
    console.log(`📨 Incoming message from ${senderId}: ${message}`);

    // Determine recipient
    const receiverId = senderId === "user1" ? "user2" : "user1";

    // Fetch receiver's FCM token
    const tokenDoc = await admin
      .firestore()
      .collection("fcm_tokens")
      .doc(receiverId)
      .get();

    if (!tokenDoc.exists) {
      console.log(`❌ No FCM token found for ${receiverId}`);
      return res.json({ success: false, error: "No token found for receiver" });
    }

    const token = tokenDoc.data().token;
    console.log(`✅ Found token for ${receiverId}: ${token.substring(0, 20)}...`);

    // ✅ CRITICAL FIX: Include BOTH notification AND data fields
    const payload = {
      token,
      
      // This makes notifications work when app is killed/background
      notification: {
        title: "New Message",
        body: message.length > 100 ? message.substring(0, 100) + "..." : message
      },
      
      // Additional data for app processing
      data: {
        senderId: senderId,
        message: message,
        timestamp: Date.now().toString(),
        type: "chat_message"
      },
      
      // Android-specific configuration
      android: {
        priority: "high",
        notification: {
          channelId: "chat_messages_high", // Matches your app's channel
          sound: "default",
          priority: "high",
          defaultSound: true,
          defaultVibrateTimings: false // Your app handles vibration
        }
      }
    };

    console.log(`📤 Sending notification to ${receiverId}...`);
    const response = await admin.messaging().send(payload);
    console.log(`✅ Notification sent successfully: ${response}`);

    return res.json({ success: true, messageId: response });
    
  } catch (error) {
    console.error("❌ Error sending notification:", error);
    return res.status(500).json({ 
      success: false, 
      error: error.message || "Unknown error" 
    });
  }
});
app.post("/markAsSeen", async (req, res) => {
  try {
    const { messageIds } = req.body;
    
    if (!messageIds || !Array.isArray(messageIds)) {
      return res.status(400).json({ 
        success: false, 
        error: "messageIds array is required" 
      });
    }

    // Batch update messages
    const batch = admin.firestore().batch();
    
    messageIds.forEach(msgId => {
      const msgRef = admin.firestore()
        .collection("rooms")
        .doc("room1")
        .collection("messages")
        .doc(msgId);
      
      batch.update(msgRef, { 
        seen: true, 
        status: "seen",
        seenAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    
    await batch.commit();
    console.log(`✅ Marked ${messageIds.length} messages as seen`);
    
    return res.json({ success: true, count: messageIds.length });
    
  } catch (error) {
    console.error("❌ Error marking messages as seen:", error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ============================================================================
// OPTIONAL: Test endpoint to send notification to a specific token
// ============================================================================
app.post("/testNotification", async (req, res) => {
  try {
    const { token, title, message } = req.body;

    if (!token) {
      return res.status(400).json({ 
        success: false, 
        error: "Token is required" 
      });
    }

    const payload = {
      token,
      notification: {
        title: title || "Test Notification",
        body: message || "This is a test notification from your server"
      },
      data: {
        test: "true",
        timestamp: Date.now().toString()
      },
      android: {
        priority: "high",
        notification: {
          channelId: "chat_messages_high"
        }
      }
    };

    const response = await admin.messaging().send(payload);
    console.log(`✅ Test notification sent: ${response}`);

    return res.json({ success: true, messageId: response });
    
  } catch (error) {
    console.error("❌ Error sending test notification:", error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ============================================================================
// OPTIONAL: Save FCM token endpoint (for your app to register tokens)
// ============================================================================
app.post("/saveFCMToken", async (req, res) => {
  try {
    const { userId, token } = req.body;

    if (!userId || !token) {
      return res.status(400).json({ 
        success: false, 
        error: "userId and token are required" 
      });
    }

    await admin
      .firestore()
      .collection("fcm_tokens")
      .doc(userId)
      .set({
        token: token,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

    console.log(`✅ Token saved for ${userId}`);
    return res.json({ success: true });
    
  } catch (error) {
    console.error("❌ Error saving token:", error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ============================================================================
// Health check endpoint
// ============================================================================
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Railway uses PORT env variable
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 Server running on port ${PORT}`);
  console.log(`🚀 Railway deployment active`);
  console.log(`📱 Ready to send notifications!`);
});
