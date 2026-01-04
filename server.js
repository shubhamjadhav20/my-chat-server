import express from "express";
import admin from "firebase-admin";
import cors from "cors";
import B2 from "backblaze-b2";

const app = express();
app.use(cors());
app.use(express.json());

// Firebase setup
const serviceAccount = JSON.parse(
  Buffer.from(process.env.SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Backblaze B2 setup
const b2 = new B2({
  applicationKeyId: process.env.B2_KEY_ID,
  applicationKey: process.env.B2_APPLICATION_KEY,
});

let b2Authorized = false;
let authorizationData = null;

// Authorize B2 on startup
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

// Authorize on startup
authorizeB2();

// Default test route
app.get("/", (req, res) => {
  res.send("Chat Server is running on Railway 🚀");
});

// ============================================================================
// NEW: Get B2 Upload Authorization
// ============================================================================
app.post("/getUploadAuth", async (req, res) => {
  try {
    const { userId, fileName, fileType } = req.body;

    if (!userId || !fileName) {
      return res.status(400).json({
        success: false,
        error: "userId and fileName are required",
      });
    }

    // Try to get upload URL
    try {
      const uploadUrlResponse = await b2.getUploadUrl({
        bucketId: process.env.B2_BUCKET_ID,
      });

      console.log(`✅ Upload URL generated for ${userId}`);

      return res.json({
        success: true,
        uploadUrl: uploadUrlResponse.data.uploadUrl,
        authorizationToken: uploadUrlResponse.data.authorizationToken,
        bucketName: process.env.B2_BUCKET_NAME,
      });
    } catch (uploadError) {
      // If expired token, re-authorize and retry
      if (uploadError.status === 401 || uploadError.data?.code === 'expired_auth_token') {
        console.log("⚠️ Token expired, re-authorizing...");
        await authorizeB2();
        
        // Retry after re-authorization
        const uploadUrlResponse = await b2.getUploadUrl({
          bucketId: process.env.B2_BUCKET_ID,
        });

        console.log(`✅ Upload URL generated after re-auth for ${userId}`);

        return res.json({
          success: true,
          uploadUrl: uploadUrlResponse.data.uploadUrl,
          authorizationToken: uploadUrlResponse.data.authorizationToken,
          bucketName: process.env.B2_BUCKET_NAME,
        });
      } else {
        throw uploadError;
      }
    }
  } catch (error) {
    console.error("❌ Error getting upload auth:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============================================================================
// Send chat message notification
// ============================================================================
app.post("/sendChatMessage", async (req, res) => {
  try {
    const { senderId, message } = req.body;
    
    console.log(`📨 Incoming message from ${senderId}: ${message}`);
    const receiverId = senderId === "user1" ? "user2" : "user1";
    
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
    console.log(`✅ Found token for ${receiverId}`);
    
    // FIXED: Removed android.notification completely
    const payload = {
      token,
      data: {
        senderId: senderId,
        message: message,
        timestamp: Date.now().toString(),
        type: "chat_message",
      },
      android: {
        priority: "high"
        // ❌ REMOVED android.notification - let MyFirebaseService handle it
      },
    };
    
    console.log(`📤 Sending notification to ${receiverId}...`);
    const response = await admin.messaging().send(payload);
    console.log(`✅ Notification sent successfully`);
    
    return res.json({ success: true, messageId: response });
    
  } catch (error) {
    console.error("❌ Error sending notification:", error);
    return res.status(500).json({ 
      success: false, 
      error: error.message || "Unknown error" 
    });
  }
});

app.post("/sendCallNotification", async (req, res) => {
  try {
    const { callerId, calleeId, callType, callId } = req.body;
    
    const tokenDoc = await admin.firestore()
      .collection("fcm_tokens")
      .doc(calleeId)
      .get();
    
    if (!tokenDoc.exists) {
      return res.json({ success: false, error: "No token" });
    }
    
    const token = tokenDoc.data().token;
    const callerName = callerId === "user1" ? "Shubham" : "Prachiti";
    
    const payload = {
      token,
      data: {
        type: "incoming_call",
        callerId: callerId,
        calleeId: calleeId,
        callType: callType,
        callId: callId,
        callerName: callerName
      },
      android: {
        priority: "high"
      }
    };
    
    const response = await admin.messaging().send(payload);
    return res.json({ success: true, messageId: response });
    
  } catch (error) {
    console.error("Error sending call notification:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});
// ============================================================================
// Test notification endpoint
// ============================================================================
app.post("/testNotification", async (req, res) => {
  try {
    const { token, title, message } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: "Token is required",
      });
    }

    const payload = {
      token,
      notification: {
        title: title || "Test Notification",
        body: message || "This is a test notification from your server",
      },
      data: {
        test: "true",
        timestamp: Date.now().toString(),
      },
      android: {
        priority: "high",
        notification: {
          channelId: "chat_messages_high",
        },
      },
    };

    const response = await admin.messaging().send(payload);
    console.log(`✅ Test notification sent`);

    return res.json({ success: true, messageId: response });
  } catch (error) {
    console.error("❌ Error sending test notification:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============================================================================
// Save FCM token endpoint
// ============================================================================
app.post("/saveFCMToken", async (req, res) => {
  try {
    const { userId, token } = req.body;

    if (!userId || !token) {
      return res.status(400).json({
        success: false,
        error: "userId and token are required",
      });
    }

    await admin
      .firestore()
      .collection("fcm_tokens")
      .doc(userId)
      .set({
        token: token,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    console.log(`✅ Token saved for ${userId}`);
    return res.json({ success: true });
  } catch (error) {
    console.error("❌ Error saving token:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});
// NEW: Get signed download URL for B2 file
app.post("/getSignedUrl", async (req, res) => {
  try {
    const { fileName } = req.body;

    if (!fileName) {
      return res.status(400).json({
        success: false,
        error: "fileName is required",
      });
    }

    // Re-authorize if needed
    if (!b2Authorized) {
      await authorizeB2();
    }

    // Get download authorization
    const downloadAuth = await b2.getDownloadAuthorization({
      bucketId: process.env.B2_BUCKET_ID,
      fileNamePrefix: fileName,
      validDurationInSeconds: 86400, // 24 hours
    });

    const signedUrl = `${authorizationData.downloadUrl}/file/${process.env.B2_BUCKET_NAME}/${fileName}?Authorization=${downloadAuth.data.authorizationToken}`;

    console.log(`✅ Signed URL generated for ${fileName}`);

    return res.json({
      success: true,
      signedUrl: signedUrl,
    });
  } catch (error) {
    console.error("❌ Error getting signed URL:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
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
    uptime: process.uptime(),
    b2Authorized: b2Authorized,
  });
});

// Railway uses PORT env variable
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 Server running on port ${PORT}`);
  console.log(`🚀 Railway deployment active`);
  console.log(`📱 Ready to send notifications!`);
});
