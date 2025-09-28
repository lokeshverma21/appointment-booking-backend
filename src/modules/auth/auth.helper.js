// src/helpers/authHelpers.js
import jwt from "jsonwebtoken";
import crypto from "crypto";

/**
 * Create short-lived access token (15m)
 */
export function createAccessToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "15m" });
}

/**
 * Create long-lived refresh token (30d)
 */
export function createRefreshToken(payload) {
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: "30d" });
}

/**
 * Hash a token before storing in DB
 */
export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Set cookies for access + refresh tokens
 */
export function setAuthCookies(res, accessToken, refreshToken) {
  // Access token short lived
  res.cookie("access_token", accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 15 * 60 * 1000,
  });

  // Refresh token long lived
  res.cookie("refresh_token", refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

/**
 * Clear auth cookies
 */
export function clearAuthCookies(res) {
  res.clearCookie("access_token");
  res.clearCookie("refresh_token");
}

/**
 * Create JWT payload shape
 */
export function makePayload(userId, tenantId, role) {
  return { userId, tenantId: tenantId ?? null, role };
}
