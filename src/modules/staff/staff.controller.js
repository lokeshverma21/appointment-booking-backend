// src/modules/staff/staff.controller.js
import { ApiError } from "../../utils/apiError.js";
import { ApiResponse } from "../../utils/apiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { prisma } from "../../lib/prisma.js";

/**
 * Utility: Tenant role check
 */
function requireTenantRole(user, roles = []) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  if (!allowed.includes(user?.role) && !allowed.includes(user?.tenantRole)) {
    throw new ApiError(403, "Forbidden – insufficient permissions");
  }
}

/**
 * ----------------------
 * Create Staff
 * ----------------------
 */
export const createStaff = asyncHandler(async (req, res) => {
  requireTenantRole(req.user, ["OWNER", "ADMIN"]);

  const { name, bio, avatar, userId } = req.body;
  if (!name) throw new ApiError(400, "Name is required");

  // optional link with existing user
  if (userId) {
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
    });
    if (!user) throw new ApiError(404, "Linked user not found");
  }

  const staff = await prisma.staff.create({
    data: {
      tenantId: req.tenantId,
      name: name.trim(),
      bio: bio?.trim() || null,
      avatar: avatar || null,
      userId: userId || null,
    },
  });

  return res
    .status(201)
    .json(new ApiResponse(201, staff, "Staff created successfully"));
});

/**
 * ----------------------
 * List Staff (with pagination & search)
 * ----------------------
 */
export const listStaff = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, search = "" } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const where = {
    tenantId: req.tenantId,
    deletedAt: null,
    ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
  };

  const [staff, total] = await Promise.all([
    prisma.staff.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: Number(limit),
      include: { staffServices: { include: { service: true } } },
    }),
    prisma.staff.count({ where }),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        staff,
        pagination: {
          total,
          page: Number(page),
          limit: Number(limit),
          pages: Math.ceil(total / Number(limit)),
        },
      },
      "Staff fetched successfully"
    )
  );
});

/**
 * ----------------------
 * Get Staff by ID
 * ----------------------
 */
export const getStaff = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const staff = await prisma.staff.findFirst({
    where: { id, tenantId: req.tenantId, deletedAt: null },
    include: { staffServices: { include: { service: true } } },
  });

  if (!staff) throw new ApiError(404, "Staff not found");

  return res
    .status(200)
    .json(new ApiResponse(200, staff, "Staff fetched successfully"));
});

/**
 * ----------------------
 * Update Staff
 * ----------------------
 */
export const updateStaff = asyncHandler(async (req, res) => {
  requireTenantRole(req.user, ["OWNER", "ADMIN"]);
  const { id } = req.params;
  const { name, bio, avatar } = req.body;

  const updated = await prisma.staff.updateMany({
    where: { id, tenantId: req.tenantId, deletedAt: null },
    data: { name, bio, avatar },
  });

  if (updated.count === 0) throw new ApiError(404, "Staff not found");

  const staff = await prisma.staff.findFirst({ where: { id } });

  return res
    .status(200)
    .json(new ApiResponse(200, staff, "Staff updated successfully"));
});

/**
 * ----------------------
 * Soft Delete Staff
 * ----------------------
 */
export const deleteStaff = asyncHandler(async (req, res) => {
  requireTenantRole(req.user, ["OWNER", "ADMIN"]);
  const { id } = req.params;

  const deleted = await prisma.staff.updateMany({
    where: { id, tenantId: req.tenantId, deletedAt: null },
    data: { deletedAt: new Date() },
  });

  if (deleted.count === 0)
    throw new ApiError(404, "Staff not found or already deleted");

  return res
    .status(200)
    .json(new ApiResponse(200, { id }, "Staff deleted successfully"));
});

/**
 * ----------------------
 * Assign Service to Staff
 * ----------------------
 */
export const assignService = asyncHandler(async (req, res) => {
  requireTenantRole(req.user, ["OWNER", "ADMIN"]);
  const { id } = req.params; // staffId
  const { serviceId } = req.body;

  if (!serviceId) throw new ApiError(400, "serviceId is required");

  const staff = await prisma.staff.findFirst({
    where: { id, tenantId: req.tenantId, deletedAt: null },
  });
  if (!staff) throw new ApiError(404, "Staff not found");

  const service = await prisma.service.findFirst({
    where: { id: serviceId, tenantId: req.tenantId, deletedAt: null },
  });
  if (!service) throw new ApiError(404, "Service not found");

  try {
    const relation = await prisma.staffService.create({
      data: { staffId: id, serviceId },
    });

    return res
      .status(200)
      .json(
        new ApiResponse(200, relation, "Service assigned to staff successfully")
      );
  } catch (err) {
    if (err.code === "P2002") {
      throw new ApiError(409, "Service already assigned to this staff");
    }
    throw err;
  }
});

/**
 * ----------------------
 * Unassign Service from Staff
 * ----------------------
 */
export const unassignService = asyncHandler(async (req, res) => {
  requireTenantRole(req.user, ["OWNER", "ADMIN"]);
  const { id } = req.params; // staffId
  const { serviceId } = req.body;

  if (!serviceId) throw new ApiError(400, "serviceId is required");

  const deleted = await prisma.staffService.deleteMany({
    where: { staffId: id, serviceId },
  });

  if (deleted.count === 0)
    throw new ApiError(404, "Service not assigned to this staff");

  return res
    .status(200)
    .json(new ApiResponse(200, { staffId: id, serviceId }, "Service unassigned from staff successfully"));
});
