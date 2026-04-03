import type { VercelRequest, VercelResponse } from "@vercel/node";

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const VALID_ROLES = ["GTM Engineer", "Head of Social"];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const { name, email, role, linkedin, submission } = req.body || {};

  if (!name || !email || !role || !submission) {
    return res.status(400).json({
      error: "Missing required fields",
      required: ["name", "email", "role", "submission"],
      optional: ["linkedin"],
    });
  }

  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({
      error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}`,
    });
  }

  const preview = submission.slice(0, 200) + (submission.length > 200 ? "..." : "");

  try {
    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({
        parent: { database_id: NOTION_DATABASE_ID },
        properties: {
          Name: { title: [{ text: { content: name } }] },
          Email: { email },
          Role: { select: { name: role } },
          LinkedIn: linkedin ? { url: linkedin } : { url: null },
          "Submission Preview": {
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
      const err = await response.text();
      console.error("Notion API error:", err);
      return res.status(502).json({ error: "Failed to submit application", detail: err });
    }

    return res.status(200).json({
      success: true,
      message: `Thanks for applying, ${name}! Your application for ${role} has been received.`,
    });
  } catch (err) {
    console.error("Submit error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
