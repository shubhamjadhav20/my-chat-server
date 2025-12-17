const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

// 🔥 PUT YOUR FCM SERVER KEY HERE
const FCM_KEY = "AAA...YOUR_KEY_HERE...";  // replace fully

// Notification endpoint
app.post("/notify", async (req, res) => {
    const { targetUser, text } = req.body;

    if (!targetUser || !text) {
        return res.status(400).send("Missing user or text");
    }

    const payload = {
        to: `/topics/${targetUser}`,
        priority: "high",
        data: {
            text: text,
            fromServer: "true"
        },
        notification: {
            title: "New message",
            body: text,
            android_channel_id: "chat_messages",
            priority: "high"
        }
    };

    try {
        const response = await axios.post(
            "https://fcm.googleapis.com/fcm/send",
            payload,
            {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `key=${FCM_KEY}`
                }
            }
        );

        console.log("Notification sent:", response.data);
        res.send("OK");
    } catch (err) {
        console.error("FCM ERROR:", err.response?.data || err.message);
        res.status(500).send("Error sending notification");
    }
});

app.get("/", (req, res) => res.send("Server is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
