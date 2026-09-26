// src/auth.js
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}
function checkPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}
function signToken(user) {
  return jwt.sign({ sub: user.id, name: user.name }, process.env.JWT_SECRET, { expiresIn: "30d" });
}

/** Attaches req.userId / req.userName when a valid Bearer token is present. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Sign in required." });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.sub;
    req.userName = payload.name;
    next();
  } catch (e) {
    res.status(401).json({ error: "Session expired — please sign in again." });
  }
}

/** Like requireAuth, but doesn't fail when there's no token — just leaves req.userId unset. */
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next();
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.sub;
    req.userName = payload.name;
  } catch (e) {}
  next();
}

module.exports = { hashPassword, checkPassword, signToken, requireAuth, optionalAuth };
