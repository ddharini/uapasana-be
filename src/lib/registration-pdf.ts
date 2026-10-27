import { createHmac, timingSafeEqual } from "crypto";

import PDFDocument from "pdfkit";
import type { Registration } from "@prisma/client";

import { EVENT_NAME, formatDay, statusOf } from "./event";
import { wantsBed } from "./registrations";

/**
 * The registration as a one- or two-page PDF, behind a link in the WhatsApp
 * confirmation (registration-confirmation.ts), to open on the phone and show
 * at the desk. It replaces putting every person's details in the message
 * itself, which a template can only do one fixed line at a time (Meta refuses
 * a newline inside a value).
 *
 * A link rather than a file attached to the message, because an attachment
 * needs a template with a Document header — a new template and another wait
 * for Meta — while a link fits the approved one's `{{4}}`. Rendered on every
 * open, so after an edit the same link shows the new details.
 *
 * English only, whatever language the form was in. pdfkit's built-in
 * Helvetica covers Latin-1 and nothing else, and Gujarati needs an embedded
 * font plus conjunct shaping that has to be checked by eye before a devotee
 * sees it. Names and family names are English letters only already (the
 * form and `newRegistrationSchema` refuse anything else), so the only
 * Gujarati would be the labels.
 */

type Member = Registration["members"][number];
type Travel = NonNullable<Member["travel"]>;

/** Mirrors TRAVEL_MODES in the frontend's features/registrations/types.ts. */
const TRAVEL_LABELS: Record<string, string> = {
  personal_vehicle: "Personal vehicle",
  mandal_bus: "Mandal bus",
  train: "Train",
  flight: "Flight",
  public_bus: "Public bus / ST",
  other: "Other",
  local: "Local",
  not_filled: "Not filled",
  separate: "Travelling separately",
};

const STATUS_LABELS: Record<string, string> = {
  confirmed: "Registered",
  checked_in: "Checked in",
  cancelled: "Cancelled",
};

const capitalise = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** "30 Jan, morning". */
export const formatStayPoint = (point: { date: string; slot: string }) =>
  `${formatDay(point.date)}, ${point.slot}`;

/**
 * Helvetica draws WinAnsi only: anything past Latin-1, bar the dashes and
 * quotes WinAnsi adds, would come out as a wrong glyph rather than an error.
 * A `?` is at least visibly a gap.
 */
export const pdfText = (value: string) => value.replace(/[^\u0000-ÿ–—‘’“”•…]/g, "?");

/** One row of the people table, in column order. */
export function personRow(registration: Pick<Registration, "accommodationRequired">, m: Member) {
  return [
    m.code ?? "",
    m.fullName,
    `${capitalise(m.gender)}, ${m.age}`,
    m.isPrimary ? "Contact" : (m.relation ?? ""),
    formatStayPoint(m.arrival),
    formatStayPoint(m.departure),
    wantsBed(registration, m) ? "Yes" : "No",
  ];
}

/** How one journey reads: the mode, then whatever was given for it. */
export function travelLines(travel: Travel): string[] {
  const lines = [TRAVEL_LABELS[travel.mode] ?? travel.mode];
  if (travel.mode === "personal_vehicle") {
    const plates = travel.vehicleNumbers.filter(Boolean);
    const count = travel.vehicleCount ?? plates.length;
    if (count > 0) {
      lines.push(`Vehicles: ${count}${plates.length ? ` (${plates.join(", ")})` : ""}`);
    }
  }
  const arriving = [
    travel.reference,
    travel.station && `to ${travel.station}`,
    travel.arrivalTime && `at ${travel.arrivalTime}`,
  ].filter(Boolean);
  if (arriving.length) lines.push(`Arriving: ${arriving.join(" ")}`);
  if (travel.needsPickup) lines.push("Pickup in Ahmedabad: Yes");
  if (travel.needsDrop) {
    const leaving = [
      travel.departureMode && TRAVEL_LABELS[travel.departureMode],
      travel.departureReference,
      travel.departureStation && `from ${travel.departureStation}`,
      travel.departureTime && `at ${travel.departureTime}`,
    ].filter(Boolean);
    lines.push(`Drop when leaving: Yes${leaving.length ? ` - ${leaving.join(" ")}` : ""}`);
  }
  return lines;
}

/** The travel section: the party's, or each person's when they travel separately. */
export function travelSection(registration: Pick<Registration, "travel" | "members">): string[] {
  if (registration.travel.mode !== "separate") return travelLines(registration.travel);
  return registration.members.map(m => {
    const own = m.travel ? travelLines(m.travel).join("; ") : "Not given";
    return `${m.fullName}: ${own}`;
  });
}

/** "27 Oct 2026", in India's time zone: the date the devotee saw it happen. */
const formatDate = (date: Date) =>
  new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(date);

const MARGIN = 40;
const INK = "#1f2937";
const MUTED = "#6b7280";
const RULE = "#d1d5db";
/** Code, name, gender and age, relation, arrives, leaves, bed — 515pt, A4 less the margins. */
const COLUMNS = [62, 138, 62, 62, 75, 75, 41];
const HEADINGS = ["No.", "Name", "Gender, age", "Relation", "Arrives", "Leaves", "Bed"];

/** Renders the registration. Resolves to the PDF's bytes. */
export function registrationPdf(registration: Registration): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margin: MARGIN,
    info: { Title: `${registration.code} - ${EVENT_NAME} 2027`, Author: "Anoopam Mission" },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", chunk => chunks.push(chunk as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const width = doc.page.width - MARGIN * 2;
  const bottom = () => doc.page.height - MARGIN;
  const text = (value: string) => pdfText(value);

  const heading = (title: string) => {
    if (doc.y > bottom() - 60) doc.addPage();
    doc.moveDown(1).font("Helvetica-Bold").fontSize(12).fillColor(INK).text(title, MARGIN);
    const y = doc.y + 2;
    doc
      .moveTo(MARGIN, y)
      .lineTo(MARGIN + width, y)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();
    doc.y = y + 6;
  };

  const field = (label: string, value: string) => {
    doc.font("Helvetica-Bold").fontSize(10).fillColor(MUTED).text(`${label}: `, MARGIN, doc.y, {
      continued: true,
    });
    doc.font("Helvetica").fillColor(INK).text(text(value));
  };

  // Title.
  doc.font("Helvetica-Bold").fontSize(18).fillColor(INK).text(`${EVENT_NAME} 2027`);
  doc.font("Helvetica").fontSize(11).fillColor(MUTED).text("Registration details - Ahmedabad");
  doc.moveDown(0.8);
  doc.font("Helvetica").fontSize(10).fillColor(MUTED).text("Registration number");
  doc.font("Helvetica-Bold").fontSize(22).fillColor(INK).text(registration.code);

  // The registration.
  heading("Registration");
  const contact = registration.members.find(m => m.isPrimary) ?? registration.members[0];
  field("Type", registration.type === "family" ? "Family" : "Individual");
  if (registration.groupName) field("Family name", registration.groupName);
  field("Mandal", registration.mandal);
  if (contact)
    field("Contact", `${contact.fullName}${contact.mobile ? `, ${contact.mobile}` : ""}`);
  field("People", String(registration.members.length));
  field(
    "Stay",
    `${formatStayPoint(registration.arrival)} - ${formatStayPoint(registration.departure)}`
  );
  field("Status", STATUS_LABELS[statusOf(registration.status)] ?? registration.status);
  field("Registered on", formatDate(registration.createdAt));
  if (registration.editedAt) field("Last updated", formatDate(registration.editedAt));

  // The people, one row each. A long name wraps, so each row is as tall as
  // its tallest cell, and a row that would cross the bottom starts a page
  // with the headings again.
  heading("People");
  const drawRow = (cells: string[], bold: boolean) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    const height =
      Math.max(
        ...cells.map((cell, i) => doc.heightOfString(text(cell), { width: COLUMNS[i] - 6 }))
      ) + 6;
    if (doc.y + height > bottom()) {
      doc.addPage();
      if (!bold) drawRow(HEADINGS, true);
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    }
    const top = doc.y;
    let x = MARGIN;
    cells.forEach((cell, i) => {
      doc.fillColor(bold ? MUTED : INK).text(text(cell), x + 3, top + 3, { width: COLUMNS[i] - 6 });
      x += COLUMNS[i];
    });
    doc
      .moveTo(MARGIN, top + height)
      .lineTo(MARGIN + width, top + height)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();
    doc.y = top + height;
  };
  drawRow(HEADINGS, true);
  for (const member of registration.members) drawRow(personRow(registration, member), false);

  heading("Travel");
  doc.font("Helvetica").fontSize(10).fillColor(INK);
  for (const line of travelSection(registration)) doc.text(text(line), MARGIN, doc.y, { width });

  // What to do with it.
  doc.moveDown(1.5);
  if (doc.y > bottom() - 50) doc.addPage();
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(MUTED)
    .text(
      "Please show this at the registration desk when you arrive. To change any details, open " +
        'the registration link again and choose "Change my registration". The link in your ' +
        "WhatsApp message always opens your latest details.",
      MARGIN,
      doc.y,
      { width }
    )
    .moveDown(0.5)
    .text("Anoopam Mission");

  doc.end();
  return done;
}

/**
 * The link is public — the devotee opens it without signing in — so it is
 * signed: the registration's id and an HMAC of it under BETTER_AUTH_SECRET.
 * Nobody can reach another family's PDF by changing the id, and there is
 * nothing to store. It does not expire: the desk needs it in January. The
 * prefix keeps this signature from ever matching one made for anything else
 * with the same secret.
 */
const signature = (id: string, secret: string) =>
  createHmac("sha256", secret).update(`registration-pdf:${id}`).digest("hex").slice(0, 32);

const pdfSecret = () => {
  const secret = process.env.BETTER_AUTH_SECRET;
  return secret && secret !== "replace-me" ? secret : null;
};

/** "<id>-<signature>": what goes in the link. Null without a secret to sign with. */
export function pdfToken(id: string): string | null {
  const secret = pdfSecret();
  return secret ? `${id}-${signature(id, secret)}` : null;
}

/** The registration id a token was made for, or null when it was not made here. */
export function idFromPdfToken(token: string): string | null {
  const secret = pdfSecret();
  const match = /^([0-9a-f]{24})-([0-9a-f]{32})(?:\.pdf)?$/.exec(token);
  if (!secret || !match) return null;
  const expected = Buffer.from(signature(match[1], secret));
  const given = Buffer.from(match[2]);
  return timingSafeEqual(expected, given) ? match[1] : null;
}

/**
 * The link to a registration's PDF on this server (`BETTER_AUTH_URL` is its
 * public origin). Ends in ".pdf" so a phone treats it as a document. Null when
 * the server cannot sign one.
 */
export function registrationPdfUrl(id: string): string | null {
  const token = pdfToken(id);
  const origin = process.env.BETTER_AUTH_URL?.replace(/\/+$/, "");
  return token && origin ? `${origin}/api/registrations/pdf/${token}.pdf` : null;
}
