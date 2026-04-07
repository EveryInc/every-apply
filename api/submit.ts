import type { VercelRequest, VercelResponse } from "@vercel/node";

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const VALID_ROLES = ["GTM Engineer", "Head of Social"];
const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const MAX_PROFILE_URL_LENGTH = 500;
const MAX_SUBMISSION_LENGTH = 4000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROBE_PATTERNS = [
  /<\s*script\b/i,
  /\bonerror\s*=/i,
  /\bunion\s+select\b/i,
  /\bpg_sleep\s*\(/i,
  /\bwaitfor\s+delay\b/i,
  /\bor\s+['"]?1['"]?\s*=\s*['"]?1/i,
];

type SubmissionInput = {
  name: string;
  email: string;
  role: string;
  linkedin: string;
  submission: string;
};

type ValidationResult =
  | { ok: true; value: SubmissionInput }
  | { ok: false; status: number; error: string; reason: string };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  if (!isJsonRequest(req)) {
    logRejected("invalid_content_type");
    return res.status(415).json({ error: "Content-Type must be application/json" });
  }

  const validation = validateBody(parseBody(req.body));
  if (validation.ok === false) {
    logRejected(validation.reason);
    return res.status(validation.status).json({
      error: validation.error,
      required: ["name", "email", "role", "submission"],
      optional: ["linkedin"],
    });
  }

  const { name, email, role, linkedin, submission } = validation.value;
  const preview = submission.slice(0, 200) + (submission.length > 200 ? "..." : "");

  try {
    const notionHeaders = getNotionHeaders();
    const duplicate = await hasExistingApplication(notionHeaders, email, role);
    if (duplicate) {
      console.info(
        JSON.stringify({
          event: "application_duplicate",
          role,
        }),
      );
      return res.status(200).json({
        success: true,
        message: `Thanks for applying, ${name}! Your application for ${role} has already been received.`,
      });
    }

    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: notionHeaders,
      body: JSON.stringify({
        parent: { database_id: NOTION_DATABASE_ID },
        properties: {
          Name: { title: [{ text: { content: name } }] },
          Email: { email },
          Role: { select: { name: role } },
          LinkedIn: linkedin ? { url: linkedin } : { url: null },
          "Submission": {
            rich_text: [{ text: { content: preview } }],
          },
          Status: { select: { name: "New" } },
        },
        children: [
          {
            object: "block",
            type: "heading_2",
            heading_2: {
              rich_text: [{ type: "text", text: { content: "Submission" } }],
            },
          },
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [
                {
                  type: "text",
                  text: { content: submission.slice(0, 2000) },
                },
              ],
            },
          },
          ...(submission.length > 2000
            ? [
                {
                  object: "block",
                  type: "paragraph",
                  paragraph: {
                    rich_text: [
                      {
                        type: "text",
                        text: { content: submission.slice(2000, 4000) },
                      },
                    ],
                  },
                },
              ]
            : []),
        ],
      }),
    });

    if (!response.ok) {
      console.error(
        JSON.stringify({
          event: "notion_insert_failed",
          status: response.status,
          statusText: response.statusText,
        }),
      );
      return res.status(502).json({ error: "Failed to submit application" });
    }

    return res.status(200).json({
      success: true,
      message: `Thanks for applying, ${name}! Your application for ${role} has been received.`,
    });
  } catch {
    console.error(JSON.stringify({ event: "submit_error" }));
    return res.status(500).json({ error: "Internal error" });
  }
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;

  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function validateBody(body: unknown): ValidationResult {
  if (!isRecord(body)) {
    return reject("invalid_json", "Request body must be a JSON object");
  }

  const name = getTrimmedString(body.name);
  const email = getTrimmedString(body.email).toLowerCase();
  const role = getTrimmedString(body.role);
  const linkedin = getOptionalTrimmedString(body.linkedin);
  const submission = getTrimmedString(body.submission);

  if (!name || !email || !role || !submission) {
    return reject("missing_required_fields", "Missing required fields");
  }

  if (
    !isString(body.name) ||
    !isString(body.email) ||
    !isString(body.role) ||
    !isString(body.submission) ||
    !isOptionalString(body.linkedin)
  ) {
    return reject("invalid_field_type", "Fields must be strings");
  }

  if (!VALID_ROLES.includes(role)) {
    return reject("invalid_role", `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}`);
  }

  if (hasControlLineBreak(name) || hasControlLineBreak(email)) {
    return reject("line_break_in_identity_field", "Name and email cannot contain line breaks");
  }

  if (name.length > MAX_NAME_LENGTH) {
    return reject("name_too_long", "Name is too long");
  }

  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return reject("invalid_email", "Email must be valid");
  }

  if (linkedin.length > MAX_PROFILE_URL_LENGTH) {
    return reject("profile_url_too_long", "Profile URL is too long");
  }

  if (linkedin && !isAllowedProfileUrl(linkedin)) {
    return reject("invalid_profile_url", "Profile URL must be a public HTTPS URL");
  }

  if (submission.length > MAX_SUBMISSION_LENGTH) {
    return reject("submission_too_long", "Submission is too long");
  }

  if (isLowSignalSubmission(submission)) {
    return reject("low_signal_submission", "Submission needs a substantive answer");
  }

  if (containsProbePayload([name, email, linkedin, submission])) {
    return reject("probe_payload", "Submission contains unsupported content");
  }

  return {
    ok: true,
    value: { name, email, role, linkedin, submission },
  };
}

async function hasExistingApplication(
  headers: Record<string, string>,
  email: string,
  role: string,
): Promise<boolean> {
  const response = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      filter: {
        and: [
          { property: "Email", email: { equals: email } },
          { property: "Role", select: { equals: role } },
        ],
      },
      page_size: 1,
    }),
  });

  if (!response.ok) {
    console.error(
      JSON.stringify({
        event: "notion_duplicate_check_failed",
        status: response.status,
        statusText: response.statusText,
      }),
    );
    throw new Error("Notion duplicate check failed");
  }

  const data = (await response.json()) as { results?: unknown[] };
  return Array.isArray(data.results) && data.results.length > 0;
}

function getNotionHeaders(): Record<string, string> {
  if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
    throw new Error("Notion environment variables are not configured");
  }

  return {
    Authorization: `Bearer ${NOTION_API_KEY}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };
}

function isJsonRequest(req: VercelRequest): boolean {
  const header = req.headers["content-type"];
  const contentType = Array.isArray(header) ? header[0] : header;
  return typeof contentType === "string" && contentType.toLowerCase().includes("application/json");
}

function isAllowedProfileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !isPrivateOrLocalHost(url.hostname);
  } catch {
    return false;
  }
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]"
  ) {
    return true;
  }

  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;

  const [first, second] = parts;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isLowSignalSubmission(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    ["test", "testing", "asdf", "n/a", "na", "none"].includes(normalized) ||
    /^([a-z0-9])\1{9,}$/i.test(normalized)
  );
}

function containsProbePayload(values: string[]): boolean {
  return values.some((value) => PROBE_PATTERNS.some((pattern) => pattern.test(value)));
}

function logRejected(reason: string) {
  console.info(
    JSON.stringify({
      event: "application_rejected",
      reason,
    }),
  );
}

function reject(reason: string, error: string, status = 400): ValidationResult {
  return { ok: false, status, reason, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalString(value: unknown): value is string | undefined | null {
  return value === undefined || value === null || typeof value === "string";
}

function getTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getOptionalTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasControlLineBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}
