import dotenv from "dotenv";
import { app } from "./app.js";
import prisma from "./db/db.js";

dotenv.config({ path: "./.env" });

(async () => {
  try {
    await prisma.$connect();
    console.log("✅ Connected to PostgreSQL");

    app.listen(process.env.PORT || 8000, () => {
      console.log(`🚀 Server running on port ${process.env.PORT || 8000}`);
    });

    // Graceful shutdown on SIGTERM (for production environments) and SIGINT (manual termination)
    process.on('SIGTERM', async () => {
      console.log('Received SIGTERM. Shutting down gracefully...');
      
      // Disconnect Prisma client
      await prisma.$disconnect();
      console.log('✅ Disconnected from PostgreSQL');
      
      // Exit process
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      console.log('Received SIGINT. Shutting down gracefully...');
      
      // Disconnect Prisma client
      await prisma.$disconnect();
      console.log('✅ Disconnected from PostgreSQL');
      
      // Exit process
      process.exit(0);
    });

    
  } catch (err) {
    console.error("❌ Failed to connect to DB", err);
    process.exit(1);
  }
})();
