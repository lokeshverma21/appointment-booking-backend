import { Router } from "express";
import {
  createService,
  listServices,
  getService,
  updateService,
  deleteService,
  assignStaff,
} from "./service.controller.js";
import { authMiddleware } from "../../middlewares/auth.middleware.js";

const router = Router();

// Protected routes (tenant required)
router.route("/")
  .post(authMiddleware, createService)   // Create service
  .get(authMiddleware, listServices);    // List services

router.route("/:id")
  .get(authMiddleware, getService)       // Get single service
  .put(authMiddleware, updateService)    // Update service
  .delete(authMiddleware, deleteService);// Soft delete service

// Assign staff to service
router.route("/:id/assign-staff").post(authMiddleware, assignStaff);

export default router;
