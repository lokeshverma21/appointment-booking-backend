// tenant.middleware.js
export function tenantMiddleware(req, res, next) {
  // Case 1: Subdomain (acme.yourapp.com)
  // req.tenantId = extractTenantFromSubdomain(req.hostname);

  // Case 2: Custom domain (saved in DB)
  // req.tenantId = lookupTenantFromDomain(req.hostname);

  // Case 3: Token (after login, tenantId embedded in JWT or session)
  req.tenantId = req.user?.tenantId || null;

  if (!req.tenantId) {
    return res.status(400).json({ message: "Tenant not resolved" });
  }

//   req.tenantId = tenantId;
//   req.prisma = prismaWithTenant(tenantId); // attach directly

  next();
}
