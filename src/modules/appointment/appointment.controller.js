// src/modules/appointment/appointment.controller.js
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
 * Helper: parse "HH:MM" into minutes since midnight
 */
function hhmmToMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map((x) => Number(x));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/**
 * Helper: check recurring availability contains the given time window.
 * NOTE: This uses UTC-based day-of-week and time. For tenant timezones, convert start/end into tenant local times first.
 */
function isWithinRecurringAvailability(av, startDate, endDate) {
  if (!av.dayOfWeek || !av.startTime || !av.endTime) return false;
  const startDow = startDate.getUTCDay(); // 0..6 (Sunday..Saturday)
  const avDow = av.dayOfWeek;
  if (startDow !== avDow) return false;

  const apptStartMinutes = startDate.getUTCHours() * 60 + startDate.getUTCMinutes();
  const apptEndMinutes = endDate.getUTCHours() * 60 + endDate.getUTCMinutes();
  const avStart = hhmmToMinutes(av.startTime);
  const avEnd = hhmmToMinutes(av.endTime);
  if (avStart === null || avEnd === null) return false;

  // must be fully inside availability window
  return apptStartMinutes >= avStart && apptEndMinutes <= avEnd;
}

/**
 * Helper: check one-off availability (startDate/endDate stored as Date)
 * availability.startDate..endDate inclusive -> must contain appointment interval
 */
function isWithinOneOffAvailability(av, startDate, endDate) {
  if (!av.startDate || !av.endDate) return false;
  const avStart = new Date(av.startDate);
  const avEnd = new Date(av.endDate);
  return startDate >= avStart && endDate <= avEnd;
}

/**
 * Validate appointment against staff availability and timeOffs.
 * Throws ApiError when invalid.
 */
async function validateStaffAvailabilityAndTimeOff(tenantId, staffId, startDate, endDate) {
  // fetch availability and timeOff for the staff within tenant
  const [availabilities, timeOffs] = await Promise.all([
    prisma.availability.findMany({
      where: { staffId, tenantId, deletedAt: null },
    }),
    prisma.timeOff.findMany({
      where: {
        staffId,
        tenantId,
        // timeoffs that overlap the requested window
        OR: [
          { start: { lte: endDate }, end: { gte: startDate } },
        ],
      },
    }),
  ]);

  // If any timeOff overlaps -> blocked
  if (timeOffs && timeOffs.length > 0) {
    // return a descriptive message with first overlap reason
    const tf = timeOffs[0];
    const reason = tf.reason || "Time off";
    throw new ApiError(409, `Staff is on time off (${reason}) during requested time`);
  }

  // If there are explicit availabilities, require that appointment be fully inside at least one availability slot.
  // If no availabilities found for staff, we interpret that as "no availability restrictions" (i.e., staff can be booked anytime).
  if (!availabilities || availabilities.length === 0) return;

  // Check if any availability covers the interval.
  const ok = availabilities.some((av) => {
    if (av.type === "ONE_OFF") {
      return isWithinOneOffAvailability(av, startDate, endDate);
    } else if (av.type === "RECURRING") {
      return isWithinRecurringAvailability(av, startDate, endDate);
    }
    return false;
  });

  if (!ok) {
    throw new ApiError(409, "Requested time is outside staff availability");
  }
}

/**
 * ----------------------
 * Create Appointment
 * ----------------------
 * Required: serviceId, staffId, clientId, start, end
 * Auto: price, currency from service
 */
export const createAppointment = asyncHandler(async (req, res) => {
  const { serviceId, staffId, clientId, start, end, notes } = req.body;

  if (!serviceId || !staffId || !clientId || !start || !end) {
    throw new ApiError(400, "Missing required fields: serviceId, staffId, clientId, start, end");
  }

  // parse times
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new ApiError(400, "Invalid start or end date");
  }

  if (endDate <= startDate) throw new ApiError(400, "end must be after start");
  if (startDate < new Date()) throw new ApiError(400, "Cannot create appointments in the past");

  // Fetch service, staff, client in parallel and validate tenant
  const [service, staff, client] = await Promise.all([
    prisma.service.findFirst({
      where: { id: serviceId, tenantId: req.tenantId, active: true, deletedAt: null },
    }),
    prisma.staff.findFirst({
      where: { id: staffId, tenantId: req.tenantId, deletedAt: null },
    }),
    prisma.user.findFirst({
      where: { id: clientId, deletedAt: null },
    }),
  ]);

  if (!service) throw new ApiError(404, "Service not found");
  if (!staff) throw new ApiError(404, "Staff not found");
  if (!client) throw new ApiError(404, "Client not found");

  // Ensure staff is assigned to service
  const assigned = await prisma.staffService.findUnique({
    where: { staffId_serviceId: { staffId, serviceId } }
  }).catch(() => null);
  if (!assigned) throw new ApiError(400, "Selected staff does not provide this service");

  // Validate duration consistency: service.duration minutes
  const expectedEnd = new Date(startDate.getTime() + service.duration * 60000);
  if (expectedEnd.getTime() !== endDate.getTime()) {
    throw new ApiError(400, `End time must be exactly ${service.duration} minutes after start`);
  }

  // Check staff availability/timeoffs
  await validateStaffAvailabilityAndTimeOff(req.tenantId, staffId, startDate, endDate);

  // Check staff double-booking (PENDING/CONFIRMED)
  const staffConflict = await prisma.appointment.findFirst({
    where: {
      tenantId: req.tenantId,
      staffId,
      status: { in: ["PENDING", "CONFIRMED"] },
      OR: [
        { start: { lt: endDate }, end: { gt: startDate } },
      ],
    },
  });
  if (staffConflict) throw new ApiError(409, "Staff already booked for this time slot");

  // Check client double-booking
  const clientConflict = await prisma.appointment.findFirst({
    where: {
      tenantId: req.tenantId,
      clientId,
      status: { in: ["PENDING", "CONFIRMED"] },
      OR: [
        { start: { lt: endDate }, end: { gt: startDate } },
      ],
    },
  });
  if (clientConflict) throw new ApiError(409, "Client already has an appointment in this time slot");

  // Create appointment transactionally
  const appointment = await prisma.$transaction(async (tx) => {
    const appt = await tx.appointment.create({
      data: {
        tenantId: req.tenantId,
        serviceId,
        staffId,
        clientId,
        start: startDate,
        end: endDate,
        price: service.price,
        currency: service.currency,
        notes: notes || null,
        status: "PENDING",
      },
      include: { service: true, staff: true, client: true },
    });

    // Optional: create notification record, audit log, enqueue background job, etc.
    // Example: create notification (queued) - background worker will handle sending
    await tx.notification.create({
      data: {
        tenantId: req.tenantId,
        userId: clientId,
        type: "booking_created",
        channel: "email",
        payload: { appointmentId: appt.id, start: appt.start, service: { id: service.id, title: service.title } },
        status: "queued",
      },
    });

    return appt;
  });

  return res.status(201).json(new ApiResponse(201, appointment, "Appointment created successfully"));
});

/**
 * ----------------------
 * List Appointments (with filters)
 * ----------------------
 */
export const listAppointments = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, status, staffId, clientId, from, to } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const where = {
    tenantId: req.tenantId,
    ...(status ? { status } : {}),
    ...(staffId ? { staffId } : {}),
    ...(clientId ? { clientId } : {}),
    ...(from ? { start: { gte: new Date(from) } } : {}),
    ...(to ? { end: { lte: new Date(to) } } : {}),
  };

  const [appointments, total] = await Promise.all([
    prisma.appointment.findMany({
      where,
      orderBy: { start: "asc" },
      skip,
      take: Number(limit),
      include: { service: true, staff: true, client: true, payment: true },
    }),
    prisma.appointment.count({ where }),
  ]);

  return res.status(200).json(
    new ApiResponse(200, {
      appointments,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit)),
      },
    }, "Appointments fetched successfully")
  );
});

/**
 * ----------------------
 * Get Appointment by ID
 * ----------------------
 */
export const getAppointment = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const appointment = await prisma.appointment.findFirst({
    where: { id, tenantId: req.tenantId },
    include: { service: true, staff: true, client: true, payment: true },
  });

  if (!appointment) throw new ApiError(404, "Appointment not found");

  return res.status(200).json(new ApiResponse(200, appointment, "Appointment fetched successfully"));
});

/**
 * ----------------------
 * Update Appointment (status, reschedule, notes)
 * Supports:
 *  - status change (CONFIRM, COMPLETE, etc.)
 *  - reschedule start/end (checks availability/conflicts)
 *  - notes update
 */
export const updateAppointment = asyncHandler(async (req, res) => {
  requireTenantRole(req.user, ["OWNER", "ADMIN", "STAFF"]);
  const { id } = req.params;
  const { status, start, end, notes } = req.body;

  const appointment = await prisma.appointment.findFirst({
    where: { id, tenantId: req.tenantId },
  });
  if (!appointment) throw new ApiError(404, "Appointment not found");

  // If rescheduling requested
  let newStart = appointment.start;
  let newEnd = appointment.end;
  if (start || end) {
    if (!start || !end) throw new ApiError(400, "Both start and end required for reschedule");
    newStart = new Date(start);
    newEnd = new Date(end);
    if (Number.isNaN(newStart.getTime()) || Number.isNaN(newEnd.getTime())) throw new ApiError(400, "Invalid start or end");
    if (newEnd <= newStart) throw new ApiError(400, "end must be after start");
    if (newStart < new Date()) throw new ApiError(400, "Cannot reschedule to the past");

    // Ensure duration equals service.duration
    const service = await prisma.service.findFirst({ where: { id: appointment.serviceId } });
    if (!service) throw new ApiError(500, "Associated service not found");
    const expectedEnd = new Date(newStart.getTime() + service.duration * 60000);
    if (expectedEnd.getTime() !== newEnd.getTime()) {
      throw new ApiError(400, `Rescheduled end must be exactly ${service.duration} minutes after start`);
    }

    // Check staff availability & timeOff
    await validateStaffAvailabilityAndTimeOff(req.tenantId, appointment.staffId, newStart, newEnd);

    // Check staff conflicts excluding this appointment
    const staffConflict = await prisma.appointment.findFirst({
      where: {
        tenantId: req.tenantId,
        staffId: appointment.staffId,
        id: { not: id },
        status: { in: ["PENDING", "CONFIRMED"] },
        OR: [{ start: { lt: newEnd }, end: { gt: newStart } }],
      },
    });
    if (staffConflict) throw new ApiError(409, "Staff already booked at the new time");

    // Check client conflicts excluding this appointment
    const clientConflict = await prisma.appointment.findFirst({
      where: {
        tenantId: req.tenantId,
        clientId: appointment.clientId,
        id: { not: id },
        status: { in: ["PENDING", "CONFIRMED"] },
        OR: [{ start: { lt: newEnd }, end: { gt: newStart } }],
      },
    });
    if (clientConflict) throw new ApiError(409, "Client already has appointment at the new time");
  }

  const updated = await prisma.appointment.update({
    where: { id },
    data: {
      status: status ?? undefined,
      start: start ? newStart : undefined,
      end: start ? newEnd : undefined,
      notes: notes ?? undefined,
      updatedAt: new Date(),
    },
    include: { service: true, staff: true, client: true },
  });

  return res.status(200).json(new ApiResponse(200, updated, "Appointment updated successfully"));
});

/**
 * ----------------------
 * Cancel Appointment
 * ----------------------
 */
export const cancelAppointment = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const result = await prisma.appointment.updateMany({
    where: { id, tenantId: req.tenantId, status: { not: "CANCELLED" } },
    data: { status: "CANCELLED", canceledAt: new Date() },
  });

  if (result.count === 0) throw new ApiError(404, "Appointment not found or already cancelled");

  // Optionally enqueue notifications / refunds etc.

  return res.status(200).json(new ApiResponse(200, { id }, "Appointment cancelled successfully"));
});
