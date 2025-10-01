import { Router } from "express";
import {
  createStaff,
  listStaff,
  getStaff,
  updateStaff,
  deleteStaff,
  assignService,
  unassignService,
} from "./staff.controller.js";
import { authMiddleware } from "../../middlewares/auth.middleware.js";

const router = Router();

// Protected routes (tenant required)
router.route("/")
  .post(authMiddleware, createStaff)    // Create staff
  .get(authMiddleware, listStaff);      // List staff (with pagination/search)

router.route("/:id")
  .get(authMiddleware, getStaff)        // Get single staff by ID
  .put(authMiddleware, updateStaff)     // Update staff
  .delete(authMiddleware, deleteStaff); // Soft delete staff

// Assign / unassign services to staff
router.route("/:id/assign-service").post(authMiddleware, assignService);
router.route("/:id/unassign-service").post(authMiddleware, unassignService);

export default router;
