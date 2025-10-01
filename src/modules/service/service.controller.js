// src/modules/service/service.controller.js
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
 * Create Service
 * ----------------------
 */
export const createService = asyncHandler(async (req, res) => {
  requireTenantRole(req.user, ["OWNER", "ADMIN"]);

  const { title, description, duration, price, currency } = req.body;

  if (!title || !duration || !price) {
    throw new ApiError(400, "Missing required fields: title, duration, price");
  }
  if (duration <= 0) throw new ApiError(400, "Duration must be positive");
  if (price < 0) throw new ApiError(400, "Price must be >= 0");

  const service = await prisma.service.create({
    data: {
      title: title.trim(),
      description: description?.trim() || null,
      duration,
      price,
      currency: currency || req.currentTenant?.currency || "USD",
      tenantId: req.tenantId,
    },
  });

  return res
    .status(201)
    .json(new ApiResponse(201, service, "Service created successfully"));
});

/**
 * ----------------------
 * List Services (with pagination & search)
 * ----------------------
 */
export const listServices = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, search = "" } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const where = {
    tenantId: req.tenantId,
    deletedAt: null,
    ...(search
      ? { title: { contains: search, mode: "insensitive" } }
      : {}),
  };

  const [services, total] = await Promise.all([
    prisma.service.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: Number(limit),
    }),
    prisma.service.count({ where }),
  ]);

  return res.status(200).json(
    new ApiResponse(200, {
      services,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit)),
      },
    },
    "Services fetched successfully")
  );
});

/**
 * ----------------------
 * Get Service by ID
 * ----------------------
 */
export const getService = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const service = await prisma.service.findFirst({
    where: { id, tenantId: req.tenantId, deletedAt: null },
    include: { staffServices: { include: { staff: true } } },
  });

  if (!service) throw new ApiError(404, "Service not found");

  return res
    .status(200)
    .json(new ApiResponse(200, service, "Service fetched successfully"));
});

/**
 * ----------------------
 * Update Service
 * ----------------------
 */
export const updateService = asyncHandler(async (req, res) => {
  requireTenantRole(req.user, ["OWNER", "ADMIN"]);
  const { id } = req.params;
  const { title, description, duration, price, currency, active } = req.body;

  if (duration !== undefined && duration <= 0)
    throw new ApiError(400, "Duration must be positive");
  if (price !== undefined && price < 0)
    throw new ApiError(400, "Price must be >= 0");

  const updated = await prisma.service.updateMany({
    where: { id, tenantId: req.tenantId, deletedAt: null },
    data: {
      title,
      description,
      duration,
      price,
      currency,
      active,
    },
  });

  if (updated.count === 0) throw new ApiError(404, "Service not found");

  const service = await prisma.service.findFirst({ where: { id, tenantId: req.tenantId } });

  return res
    .status(200)
    .json(new ApiResponse(200, service, "Service updated successfully"));
});

/**
 * ----------------------
 * Soft Delete Service
 * ----------------------
 */
export const deleteService = asyncHandler(async (req, res) => {
  requireTenantRole(req.user, ["OWNER", "ADMIN"]);
  const { id } = req.params;

  const deleted = await prisma.service.updateMany({
    where: { id, tenantId: req.tenantId, deletedAt: null },
    data: { deletedAt: new Date(), active: false },
  });

  if (deleted.count === 0) throw new ApiError(404, "Service not found or already deleted");

  return res
    .status(200)
    .json(new ApiResponse(200, { id }, "Service deleted successfully"));
});

/**
 * ----------------------
 * Assign Staff to Service
 * ----------------------
 */
export const assignStaff = asyncHandler(async (req, res) => {
  requireTenantRole(req.user, ["OWNER", "ADMIN"]);
  const { id } = req.params; // serviceId
  const { staffId } = req.body;

  if (!staffId) throw new ApiError(400, "staffId is required");

  const service = await prisma.service.findFirst({
    where: { id, tenantId: req.tenantId, deletedAt: null },
  });
  if (!service) throw new ApiError(404, "Service not found");

  const staff = await prisma.staff.findFirst({
    where: { id: staffId, tenantId: req.tenantId, deletedAt: null },
  });
  if (!staff) throw new ApiError(404, "Staff not found");

  try {
    const relation = await prisma.staffService.create({
      data: { serviceId: id, staffId },
    });

    return res
      .status(200)
      .json(new ApiResponse(200, relation, "Staff assigned to service successfully"));
  } catch (err) {
    if (err.code === "P2002") {
      throw new ApiError(409, "Staff already assigned to this service");
    }
    throw err;
  }
});
