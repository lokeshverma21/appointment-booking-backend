// lib/prismaWithTenant.ts
import { prisma } from "./prisma.js";

export function prismaWithTenant(tenantId) {
  prisma.$use(async (params, next) => {
    const tenantModels = [
      "Appointment","Service","Staff","Availability","TimeOff",
      "StaffService","Payment","Notification","Subscription","Location"
    ];

    if (tenantModels.includes(params.model)) {
      if (["findMany","findFirst","findUnique"].includes(params.action)) {
        params.args.where = { ...params.args.where, tenantId };
      }
      if (params.action === "create") {
        params.args.data.tenantId = tenantId;
      }
      if (["update","delete","updateMany","deleteMany"].includes(params.action)) {
        params.args.where = { ...params.args.where, tenantId };
      }
    }
    return next(params);
  });

  return prisma;
}
