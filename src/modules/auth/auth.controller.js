import { ApiError } from "../../utils/apiError.js";
import { ApiResponse } from "../../utils/apiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

// src/controllers/auth.controller.js
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { prisma } from "../../lib/prisma.js";
import { createAccessToken, createRefreshToken, hashToken, setAuthCookies, clearAuthCookies, makePayload } from "./auth.helper.js";
import slugify from "slugify";
import { sendEmail } from "../../utils/email.js";

/**
 * Helper: persist refresh token hash in DB
 */
async function storeRefreshToken(tx, userId, refreshToken, expiresAt) {
  const tokenHash = hashToken(refreshToken);
  const rt = await tx.refreshToken.create({
    data: { userId, tokenHash, expiresAt },
  });
  return rt;
}

/**
 * registerBusiness - Single-step signup that creates tenant + owner
 * Route: POST /api/v1/auth/register/business
 */
export const registerBusiness = asyncHandler(async (req, res) => {
  const { businessName, email, password, ownerName, timezone, currency } = req.body;
  if (!businessName || !email || !password) throw new ApiError(400, "businessName, email and password are required");
  if (password.length < 8) throw new ApiError(400, "Password must be at least 8 characters");

  // check existing email
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) throw new ApiError(409, "Email already registered");

  // slug generation
  let baseSlug = slugify(businessName || `business`, { lower: true, strict: true }).slice(0, 50);
  if (!baseSlug) baseSlug = `tenant-${crypto.randomBytes(3).toString("hex")}`;
  let slug = baseSlug;
  let i = 0;
  while (await prisma.tenant.findUnique({ where: { slug } })) {
    i++;
    slug = `${baseSlug}-${i}`;
  }

  const hashed = await bcrypt.hash(password, 12);

  // transactionally create tenant + user + tenantUser + refresh token
  const result = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: { name: businessName, slug, timezone: timezone || "UTC", currency: currency || "USD" },
    });

    const user = await tx.user.create({
      data: { name: ownerName || "Owner", email, password: hashed },
    });

    await tx.tenantUser.create({
      data: { tenantId: tenant.id, userId: user.id, role: "OWNER" },
    });

    // Create refresh token now and persist its hash
    const payload = makePayload(user.id, tenant.id, "OWNER");
    const accessToken = createAccessToken(payload);
    const refreshToken = createRefreshToken(payload);
    const decodedRefresh = jwt.decode(refreshToken);
    const expiresAt = decodedRefresh ? new Date(decodedRefresh.exp * 1000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await storeRefreshToken(tx, user.id, refreshToken, expiresAt);

    return { tenant, user, accessToken, refreshToken, expiresAt };
  });

  // set cookies
  setAuthCookies(res, result.accessToken, result.refreshToken);

  return res.status(201).json(new ApiResponse(201, { tenant: result.tenant, user: { id: result.user.id, email: result.user.email } }, "Business and owner registered"));
});

/**
 * registerClient - create client user; optional tenantSlug or tenantId for context
 * Route: POST /api/v1/auth/register/client
 */
export const registerClient = asyncHandler(async (req, res) => {
  const { email, password, name, tenantId, tenantSlug } = req.body;
  if (!email || !password) throw new ApiError(400, "email and password required");
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new ApiError(409, "Email already registered");

  let tenant = null;
  if (tenantSlug) {
    tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug }});
    if (!tenant) throw new ApiError(404, "Tenant not found");
  } else if (tenantId) {
    tenant = await prisma.tenant.findUnique({ where: { id: tenantId }});
    if (!tenant) throw new ApiError(404, "Tenant not found");
  }

  const hashed = await bcrypt.hash(password, 12);

  const user = await prisma.user.create({
    data: { email, password: hashed, name: name || "Client" },
  });

  // Create tokens and persist refresh token record
  const payload = makePayload(user.id, tenant?.id ?? null, "CLIENT");
  const accessToken = createAccessToken(payload);
  const refreshToken = createRefreshToken(payload);
  const decodedRefresh = jwt.decode(refreshToken);
  const expiresAt = decodedRefresh ? new Date(decodedRefresh.exp * 1000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await prisma.refreshToken.create({ data: { userId: user.id, tokenHash: hashToken(refreshToken), expiresAt } });

  setAuthCookies(res, accessToken, refreshToken);
  return res.status(201).json(new ApiResponse(201, { user: { id: user.id, email: user.email }, tenantId: tenant?.id ?? null }, "Client registered"));
});

/**
 * login - supports owners, staff, clients
 * Route: POST /api/v1/auth/login
 */
export const login = asyncHandler(async (req, res) => {
  const { email, password, preferredTenantId } = req.body;
  if (!email || !password) throw new ApiError(400, "Missing credentials");

  const user = await prisma.user.findUnique({
    where: { email },
    include: { tenantLinks: true },
  });
  if (!user) throw new ApiError(401, "Invalid credentials");

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) throw new ApiError(401, "Invalid credentials");

  // Determine active tenant
  let activeTenantId = null;
  if (preferredTenantId) {
    const link = await prisma.tenantUser.findUnique({
      where: { tenantId_userId: { tenantId: preferredTenantId, userId: user.id } }
    }).catch(() => null);
    if (!link) throw new ApiError(403, "Not a member of requested tenant");
    activeTenantId = preferredTenantId;
  } else if (user.tenantLinks && user.tenantLinks.length === 1) {
    activeTenantId = user.tenantLinks[0].tenantId;
  } else if (user.tenantLinks && user.tenantLinks.length > 1) {
    // default to first tenant — frontend should present switch option
    activeTenantId = user.tenantLinks[0].tenantId;
  } else {
    activeTenantId = null;
  }

  // create tokens
  const payload = makePayload(user.id, activeTenantId, user.role);
  const accessToken = createAccessToken(payload);
  const refreshToken = createRefreshToken(payload);

  // Persist refresh token hash, optionally revoke old tokens (strategy choice)
  const decodedRefresh = jwt.decode(refreshToken);
  const expiresAt = decodedRefresh ? new Date(decodedRefresh.exp * 1000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await prisma.refreshToken.create({ data: { userId: user.id, tokenHash: hashToken(refreshToken), expiresAt } });

  setAuthCookies(res, accessToken, refreshToken);

  return res.json(new ApiResponse(200, {
    user: { id: user.id, email: user.email, name: user.name },
    tenantLinks: user.tenantLinks.map(l => ({ tenantId: l.tenantId, role: l.role }))
  }, "Login successful"));
});

/**
 * logout - clear cookies and revoke refresh token (if present)
 * Route: POST /api/v1/auth/logout
 * Protected: yes
 */
export const logout = asyncHandler(async (req, res) => {
  // revoke refresh token found in cookie
  const rt = req.cookies?.refresh_token;
  if (rt) {
    const tokenHash = hashToken(rt);
    await prisma.refreshToken.updateMany({ where: { tokenHash }, data: { revoked: true } });
  }
  clearAuthCookies(res);
  return res.json(new ApiResponse(200, null, "Logged out"));
});

/**
 * refreshToken - rotate refresh token
 * Route: POST /api/v1/auth/refresh
 */
export const refreshToken = asyncHandler(async (req, res) => {
  const rt = req.cookies?.refresh_token;
  if (!rt) throw new ApiError(401, "No refresh token");

  try {
    const decoded = jwt.verify(rt, process.env.JWT_REFRESH_SECRET);
    const tokenHash = hashToken(rt);

    // find stored token and check not revoked and not expired
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!stored || stored.revoked) {
      // Possible reuse attempt -> revoke all tokens for user (optional)
      if (stored && stored.userId) {
        await prisma.refreshToken.updateMany({ where: { userId: stored.userId }, data: { revoked: true } });
      }
      throw new ApiError(401, "Refresh token revoked or invalid");
    }

    if (new Date(stored.expiresAt) < new Date()) {
      throw new ApiError(401, "Refresh token expired");
    }

    // Rotate: mark old token revoked and create new one
    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revoked: true } });

    const payload = { userId: decoded.userId, tenantId: decoded.tenantId ?? null, role: decoded.role };
    const newAccess = createAccessToken(payload);
    const newRefresh = createRefreshToken(payload);
    const newDecoded = jwt.decode(newRefresh);
    const newExpiresAt = newDecoded ? new Date(newDecoded.exp * 1000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const newStored = await prisma.refreshToken.create({ data: { userId: decoded.userId, tokenHash: hashToken(newRefresh), expiresAt: newExpiresAt, replacedById: null } });

    // Optionally link replacedById (not strictly necessary)
    await prisma.refreshToken.update({ where: { id: stored.id }, data: { replacedById: newStored.id } });

    setAuthCookies(res, newAccess, newRefresh);
    return res.json(new ApiResponse(200, null, "Tokens rotated"));
  } catch (err) {
    if (err.name === "TokenExpiredError") throw new ApiError(401, "Refresh token expired");
    throw new ApiError(401, "Invalid refresh token");
  }
});

/**
 * getMe - return user profile + tenant links
 * Route: GET /api/v1/auth/me
 * Protected: yes
 */
export const getMe = asyncHandler(async (req, res) => {
  if (!req.user) throw new ApiError(401, "Unauthorized");
  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    include: { tenantLinks: { include: { tenant: true } } }
  });
  if (!user) throw new ApiError(404, "User not found");

  return res.json(new ApiResponse(200, {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    tenantLinks: user.tenantLinks.map(l => ({ tenantId: l.tenantId, role: l.role, tenantName: l.tenant.name, slug: l.tenant.slug }))
  }, "Profile fetched"));
});

/**
 * inviteUser - tenant owner/admin invites staff
 * Route: POST /api/v1/auth/invite
 * Protected: yes (OWNER/ADMIN)
 */
export const inviteUser = asyncHandler(async (req, res) => {
  const { email, role } = req.body;
  if (!req.user || !req.user.tenantId) throw new ApiError(401, "Tenant context required");
  const tenantId = req.user.tenantId;

  // permission check: ensure req.user is OWNER or ADMIN within tenant
  const tu = await prisma.tenantUser.findUnique({
    where: { tenantId_userId: { tenantId, userId: req.user.userId } }
  });
  if (!tu || !["OWNER", "ADMIN"].includes(tu.role)) throw new ApiError(403, "Forbidden");

  // generate token
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const invite = await prisma.invite.create({
    data: { tenantId, email, role: role || "STAFF", token, createdBy: req.user.userId, expiresAt }
  });

  // send email (background recommended)
  const acceptUrl = `${process.env.APP_URL}/invite/accept?token=${invite.token}`;
  await sendEmail({
    to: email,
    subject: `You're invited to join ${req.user.tenantId}`,
    html: `<p>You were invited to join. Click <a href="${acceptUrl}">here</a> to accept.</p>`
  }).catch((err) => console.error("Invite email failed:", err));

  return res.status(201).json(new ApiResponse(201, { inviteId: invite.id }, "Invite created"));
});

/**
 * acceptInvite - user accepts invite (must be logged in or register)
 * Route: POST /api/v1/auth/invite/accept
 */
export const acceptInvite = asyncHandler(async (req, res) => {
  const { token } = req.body;
  if (!token) throw new ApiError(400, "Token required");

  const invite = await prisma.invite.findUnique({ where: { token } });
  if (!invite) throw new ApiError(400, "Invalid invite token");
  if (invite.expiresAt < new Date()) throw new ApiError(400, "Invite expired");
  if (invite.used) throw new ApiError(400, "Invite already used");

  // require authenticated user
  if (!req.user) throw new ApiError(401, "Login required to accept invite");

  // Optional: check that logged-in user's email matches invite.email
  const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
  if (!user) throw new ApiError(404, "User not found");
  if (user.email !== invite.email) {
    // You may allow accept if owner permits; for security, require matching email
    throw new ApiError(403, "Invite email does not match your account email");
  }

  // create TenantUser link idempotently
  await prisma.tenantUser.upsert({
    where: { tenantId_userId: { tenantId: invite.tenantId, userId: user.id } },
    create: { tenantId: invite.tenantId, userId: user.id, role: invite.role },
    update: { role: invite.role }
  });

  // mark invite used
  await prisma.invite.update({ where: { id: invite.id }, data: { used: true } });

  return res.json(new ApiResponse(200, null, "Invite accepted"));
});

/**
 * switchTenant - user switches active tenant (user must be member)
 * Route: POST /api/v1/auth/switch-tenant
 */
export const switchTenant = asyncHandler(async (req, res) => {
  const { targetTenantId } = req.body;
  if (!req.user) throw new ApiError(401, "Unauthorized");

  const link = await prisma.tenantUser.findUnique({
    where: { tenantId_userId: { tenantId: targetTenantId, userId: req.user.userId } }
  });
  if (!link) throw new ApiError(403, "Not a member of tenant");

  const payload = makePayload(req.user.userId, targetTenantId, link.role);
  const accessToken = createAccessToken(payload);
  const refreshToken = createRefreshToken(payload);

  // persist refresh token
  const decodedRefresh = jwt.decode(refreshToken);
  const expiresAt = decodedRefresh ? new Date(decodedRefresh.exp * 1000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({ data: { userId: req.user.userId, tokenHash: hashToken(refreshToken), expiresAt } });

  setAuthCookies(res, accessToken, refreshToken);
  return res.json(new ApiResponse(200, { tenantId: targetTenantId }, "Switched tenant"));
});

/**
 * requestPasswordReset - generates reset token and emails user
 * Route: POST /api/v1/auth/password/request
 */
export const requestPasswordReset = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) throw new ApiError(400, "Email is required");
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.json(new ApiResponse(200, null, "If an account exists, you will receive an email")); // do not reveal existence

  // token
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  // persist hashed token in refreshToken table? Better to create ResetToken model; for simplicity, reuse refreshToken as a short-lived token or create an inline record in a passwordReset table.
  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash, expiresAt }
  });

  const resetUrl = `${process.env.APP_URL}/reset-password?token=${token}&email=${encodeURIComponent(user.email)}`;
  await sendEmail({ to: user.email, subject: "Reset your password", html: `<p>Reset: <a href="${resetUrl}">${resetUrl}</a></p>` }).catch(e => console.error(e));

  return res.json(new ApiResponse(200, null, "If an account exists, you will receive an email"));
});

/**
 * resetPassword - validate token and reset
 * Route: POST /api/v1/auth/password/reset
 */
export const resetPassword = asyncHandler(async (req, res) => {
  const { token, email, newPassword } = req.body;
  if (!token || !email || !newPassword) throw new ApiError(400, "token, email and newPassword required");
  if (newPassword.length < 8) throw new ApiError(400, "Password must be at least 8 characters");

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new ApiError(400, "Invalid token or email");

  const tokenHash = hashToken(token);
  const stored = await prisma.refreshToken.findFirst({ where: { userId: user.id, tokenHash, revoked: false } });
  if (!stored) throw new ApiError(400, "Invalid or expired token");
  if (new Date(stored.expiresAt) < new Date()) throw new ApiError(400, "Token expired");

  // update password and revoke all refresh tokens
  const hashed = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: user.id }, data: { password: hashed } });
  await prisma.refreshToken.updateMany({ where: { userId: user.id }, data: { revoked: true } });

  return res.json(new ApiResponse(200, null, "Password reset successful"));
});
