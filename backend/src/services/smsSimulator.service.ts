import { maskPhoneNumber } from "../utils/password.js";
import logger from "../utils/logger.js";

export interface SimulatedMessage {
  recipientUserId: string;
  phoneNumber: string;
  messageContent: string;
  notificationType: string;
  deliveryStatus: string;
}

/**
 * Community Alert System — Simulated SMS Gateway
 *
 * Since this is a prototype, there is no real SMS provider.
 * This module simulates the delivery of SMS messages to residents
 * with a configurable simulated delay and success rate.
 */

const SIMULATED_DELAY_MS = 5000; // 5-second simulated delivery
const SIMULATED_SUCCESS_RATE = 0.98; // 98% success rate

export interface SmsRecipient {
  userId: string;
  phoneNumber: string | null;
  fullName: string;
  barangay: string;
  purok: string | null;
}

export interface SmsMessage {
  to: string;
  body: string;
  type: "ADVISORY" | "RESTORATION" | "CANCELLATION";
}

export interface SmsDeliveryResult {
  success: boolean;
  recipientUserId: string;
  phoneNumber: string;
  messageContent: string;
  notificationType: string;
  deliveryStatus: string;
  deliveredAt: Date | null;
}

/**
 * Simulate sending an SMS message.
 * Returns a result immediately but marks the message as "simulated"
 * with a future delivery timestamp.
 *
 * In production, this would be replaced by a real SMS gateway (Twilio, etc.).
 */
export async function simulateSms(
  recipient: SmsRecipient,
  message: SmsMessage
): Promise<SmsDeliveryResult> {
  const maskedPhone = recipient.phoneNumber
    ? maskPhoneNumber(recipient.phoneNumber)
    : "(no phone number)";

  const isSuccess = Math.random() < SIMULATED_SUCCESS_RATE;
  const deliveredAt = isSuccess ? new Date(Date.now() + SIMULATED_DELAY_MS) : null;

  logger.info("SMS simulated", {
    recipient: recipient.fullName,
    phone: maskedPhone,
    type: message.type,
    status: isSuccess ? "SIMULATED" : "FAILED",
    delayMs: SIMULATED_DELAY_MS,
  });

  return {
    success: isSuccess,
    recipientUserId: recipient.userId,
    phoneNumber: maskedPhone,
    messageContent: message.body,
    notificationType: message.type,
    deliveryStatus: isSuccess ? "SIMULATED" : "FAILED",
    deliveredAt,
  };
}

/**
 * Simulate sending a batch of SMS messages.
 */
export async function simulateBulkSms(
  recipients: SmsRecipient[],
  message: SmsMessage
): Promise<SmsDeliveryResult[]> {
  const results: SmsDeliveryResult[] = [];

  for (const recipient of recipients) {
    const result = await simulateSms(recipient, message);
    results.push(result);
  }

  const successCount = results.filter((r) => r.success).length;
  logger.info("Bulk SMS simulation complete", {
    total: results.length,
    success: successCount,
    failed: results.length - successCount,
  });

  return results;
}

/**
 * Format an advisory notification message for SMS.
 */
export function formatAdvisoryMessage(
  advisoryTitle: string,
  serviceType: string,
  startAt: Date,
  endAt: Date | null,
  barangayName: string,
  purokName: string | null,
  priority: string
): string {
  const serviceLabel = serviceType === "WATER" ? "tubig" : "kuryente";
  const timeLabel = startAt.toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const locationLabel = purokName
    ? `${purokName}, Brgy. ${barangayName}`
    : `Brgy. ${barangayName}`;

  let msg = `ADVISORY (${priority}): ${serviceLabel} interruption in ${locationLabel}. ${advisoryTitle}. Magsisimula ${timeLabel}.`;

  if (endAt) {
    const endTimeLabel = endAt.toLocaleString("en-PH", {
      timeZone: "Asia/Manila",
      hour: "2-digit",
      minute: "2-digit",
    });
    msg += ` Hanggang ${endTimeLabel}.`;
  }

  msg += " CAS — Community Alert System";
  return msg;
}

/**
 * Format a restoration/cancellation notification for SMS.
 */
export function formatStatusMessage(
  advisoryTitle: string,
  status: string,
  reason: string | null,
  barangayName: string,
  purokName: string | null
): string {
  const locationLabel = purokName
    ? `${purokName}, Brgy. ${barangayName}`
    : `Brgy. ${barangayName}`;

  if (status === "RESOLVED") {
    return `RESTORATION: ${advisoryTitle} sa ${locationLabel} ay natapos na. Maaari nang gumamit ng ${advisoryTitle.includes("tubig") ? "tubig" : "kuryente"}. CAS`;
  }

  if (status === "CANCELLED") {
    let msg = `CANCELLED: ${advisoryTitle} sa ${locationLabel}. `;
    if (reason) msg += `${reason}. `;
    msg += "Wala nang abalansa. CAS";
    return msg;
  }

  return `${status}: ${advisoryTitle} sa ${locationLabel}. CAS`;
}
