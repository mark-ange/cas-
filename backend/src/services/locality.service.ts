import prisma from "../utils/prisma.js";
import { NotFoundError, BadRequestError } from "../utils/appError.js";

export interface BarangayDto {
  id: string;
  name: string;
  city: string;
  active: boolean;
  createdAt: Date;
}

export interface PurokDto {
  id: string;
  name: string;
  barangayId: string;
  barangayName: string;
  active: boolean;
  createdAt: Date;
}

/**
 * Fetch all active barangays, sorted alphabetically by name.
 * Includes active puroks nested within each barangay.
 */
export async function getBarangays(): Promise<any[]> {
  return prisma.barangay.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    include: { puroks: { where: { active: true }, orderBy: { name: "asc" } } },
  });
}

export async function getBarangayById(id: string): Promise<any> {
  const barangay = await prisma.barangay.findUnique({
    where: { id },
    include: { puroks: { where: { active: true }, orderBy: { name: "asc" } } },
  });
  if (!barangay) throw new NotFoundError("Barangay not found");
  return barangay;
}

export async function getPuroks(barangayId: string): Promise<any[]> {
  const barangay = await prisma.barangay.findUnique({ where: { id: barangayId } });
  if (!barangay) throw new NotFoundError("Barangay not found");

  return prisma.purok.findMany({
    where: { barangayId, active: true },
    orderBy: { name: "asc" },
  });
}

export async function getPurokById(id: string): Promise<any> {
  const purok = await prisma.purok.findUnique({
    where: { id },
    include: { barangay: true },
  });
  if (!purok) throw new NotFoundError("Purok not found");
  return purok;
}

/**
 * Create a new barangay (admin-only).
 */
export async function createBarangay(data: { name: string; city: string }): Promise<any> {
  const existing = await prisma.barangay.findUnique({ where: { name: data.name.trim() } });
  if (existing) throw new BadRequestError("A barangay with that name already exists");

  return prisma.barangay.create({
    data: {
      name: data.name.trim(),
      city: data.city || "Cagayan de Oro City",
    },
  });
}

/**
 * Create a new purok under a barangay (admin-only).
 */
export async function createPurok(data: { name: string; barangayId: string }): Promise<any> {
  const barangay = await prisma.barangay.findUnique({ where: { id: data.barangayId } });
  if (!barangay) throw new NotFoundError("Barangay not found");

  return prisma.purok.create({
    data: {
      name: data.name.trim(),
      barangayId: data.barangayId,
    },
    include: { barangay: true },
  });
}

/**
 * Update a locality (barangay or purok).
 */
export async function updateBarangay(id: string, data: { name?: string; active?: boolean }): Promise<any> {
  return prisma.barangay.update({
    where: { id },
    data,
  });
}

export async function updatePurok(id: string, data: { name?: string; active?: boolean }): Promise<any> {
  return prisma.purok.update({
    where: { id },
    data,
  });
}
