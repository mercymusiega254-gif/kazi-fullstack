// src/server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { initSchema } = require("./db");

const { router: authRouter } = require("./routes/auth");
const tasksRouter = require("./routes/tasks");
const profilesRouter = require("./routes/profiles");
const reviewsRouter = require("./routes/reviews");
const messagesRouter = require("./routes/messages");
const paymentsRouter = require("./routes/payments");

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api/profiles", profilesRouter);
app.use("/api/reviews", reviewsRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/payments", paymentsRouter);

app.use((req, res) => res.status(404).json({ error: "Not found." }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong." });
});

const port = process.env.PORT || 4000;
initSchema()
  .then(() => {
    app.listen(port, () => console.log(`Kazi API listening on :${port}`));
  })
  .catch((e) => {
    console.error("Failed to set up database schema:", e);
    process.exit(1);
  });
