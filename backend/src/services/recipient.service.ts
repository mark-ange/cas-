import prisma from "../utils/prisma.js";

/**
 * Estimate or fetch the list of residents who should receive a notification
 * for a given advisory, based on its targets (barangay/purok) and
 * service-type opt-in preferences.
 */

export interface EstimatedRecipient {
  userId: string;
  phoneNumber: string | null;
  fullName: string;
  barangay: string;
  purok: string | null;
  serviceType: "WATER" | "POWER";
}

export interface AdvisoryTargetInput {
  barangayId: string;
  purokIds?: string[];
}

/**
 * For a given set of advisory targets and service type, return the list
 * of residents who have opted in for that service type.
 */
export async function getRecipientsForAdvisory(
  targets: AdvisoryTargetInput[],
  serviceType: "WATER" | "POWER"
): Promise<EstimatedRecipient[]> {
  const recipients: EstimatedRecipient[] = [];

  for (const target of targets) {
    // Build where clause: barangayId required, purokId optional
    const residentWhere: any = {
      barangayId: target.barangayId,
      active: true,
    };

    if (target.purokIds && target.purokIds.length > 0) {
      residentWhere.purokId = { in: target.purokIds };
    } else {
      // If no specific puroks, all residents in the barangay
      residentWhere.purokId = {
        not: null,
      };
    }

    // Filter by service-type opt-in
    if (serviceType === "WATER") {
      residentWhere.waterOptIn = true;
    } else {
      residentWhere.powerOptIn = true;
    }

    const residents = await prisma.residentProfile.findMany({
      where: residentWhere,
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            phone: true,
          },
        },
        barangay: { select: { name: true } },
        purok: { select: { name: true } },
      },
    });

    for (const r of residents) {
      recipients.push({
        userId: r.userId,
        phoneNumber: r.user.phone,
        fullName: r.user.fullName,
        barangay: r.barangay.name,
        purok: r.purok?.name ?? null,
        serviceType,
      });
    }
  }

  // Deduplicate by userId (a resident might be in multiple target puroks)
  const seen = new Set<string>();
  return recipients.filter((r) => {
    if (seen.has(r.userId)) return false;
    seen.add(r.userId);
    return true;
  });
}

/**
 * Estimate the number of recipients for an advisory before it's published.
 * Used for the "preview" feature.
 */
export async function estimateRecipients(
  targets: AdvisoryTargetInput[],
  serviceType: "WATER" | "POWER"
): Promise<number> {
  const recipients = await getRecipientsForAdvisory(targets, serviceType);
  return recipients.length;
}
