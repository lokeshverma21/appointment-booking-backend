// src/middlewares/auth.middleware.js
import jwt from "jsonwebtoken";
import { ApiError } from "../utils/apiError.js";
import { prisma } from "../lib/prisma.js";

export async function authMiddleware(req, res, next) {
  const token = req.cookies?.access_token || null;
  if (!token) return res.status(401).json({ message: "Unauthorized" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Shape: { userId, tenantId, role, iat, exp }
    req.user = { userId: decoded.userId, tenantId: decoded.tenantId, role: decoded.role };
    // optionally attach minimal user
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) throw new ApiError(401, "User not found");
    req.currentUser = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
}
