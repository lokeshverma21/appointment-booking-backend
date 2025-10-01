import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { errorHandler, notFound } from "./middlewares/error.middleware.js";
import morgan from "morgan";

const app = express();

app.use(
    cors({
        origin: `${process.env.CORS_ORIGIN}`,
        credentials: true
    })
)

app.use(express.json({ limit: "20kb" }))
app.use(express.urlencoded({ extended: true, limit: "20kb" }))
app.use("/api/v1/uploads", express.static("uploads"));
if (process.env.NODE_ENV !== "production") {
    app.use(morgan("dev"));
}

app.use(cookieParser());

//routers
import authRouter from "./modules/auth/auth.routes.js";
import serviceRouter from "./modules/service/service.routes.js";
import staffRouter from "./modules/staff/staff.routes.js";

app.use("/api/v1/auth", authRouter)
app.use("/api/v1/service", serviceRouter)
app.use("/api/v1/staff", staffRouter)


// Middleware for handling 404 errors
app.use(notFound);

//Global error handler
app.use(errorHandler)

export { app }