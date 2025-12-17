import express from "express";
import admin from "firebase-admin";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// Railway loads JSON from env
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Default test route
app.get("/", (req, res) => {
  res.send("Chat Server is running on Railway 🚀");
});

// Send chat message notification
app.post("/sendChatMessage", async (req, res) => {
  try {
    const { senderId, message } = req.body;

    // Determine recipient
    const receiverId = senderId === "user1" ? "user2" : "user1";

    // Fetch receiver's FCM token
    const tokenDoc = await admin
      .firestore()
      .collection("fcm_tokens")
      .doc(receiverId)
      .get();

    if (!tokenDoc.exists) {
      return res.json({ success: false, error: "No token found for receiver" });
    }

    const token = tokenDoc.data().token;

    const payload = {
      token,
      data: {
        title: "New message",
        body: message
      },
      android: {
        priority: "high"
      }
    };

    const response = await admin.messaging().send(payload);

    return res.json({ success: true, response });
  } catch (error) {
    console.error("Error sending notification:", error);
    return res.status(500).json({ success: false, error });
  }
});

// Railway uses PORT env variable
app.listen(process.env.PORT || 3000, () =>
  console.log("🔥 Server running on Railway")
);
