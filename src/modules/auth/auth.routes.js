import { Router } from "express";
import { registerBusiness, acceptInvite, getMe, inviteUser, login, logout, refreshToken, registerClient, requestPasswordReset, resetPassword, switchTenant } from "./auth.controller.js";
import { authMiddleware } from "../../middlewares/auth.middleware.js";


const router = Router()

router.route("/register/business").post(registerBusiness);
router.route("/register/client").post(registerClient);
router.route("/login").post(login);
router.route("/refresh").post(refreshToken);
router.route("/password/request").post(requestPasswordReset);
router.route("/password/reset").post(resetPassword);

//protected
router.route("/logout").post(authMiddleware,logout);
router.route("/me").get(authMiddleware,getMe);
router.route("/invite").post(authMiddleware,inviteUser);
router.route("/invite/accept").post(authMiddleware,acceptInvite);
router.route("/switch-tenant").post(authMiddleware,switchTenant);

export default router;