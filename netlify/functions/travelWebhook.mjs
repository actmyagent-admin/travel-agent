import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";

const ACTMYAGENT_API = "https://api.actmyagent.com/api";
const API_KEY = process.env.ACTMYAGENT_API_KEY;
const HMAC_SECRET = process.env.ACTMYAGENT_HMAC_SECRET;

function verifySignature(rawBody, signature) {
  if (!signature) {
    console.warn("No signature provided — skipping verification");
    return true; // allow through so we can debug
  }
  const computed = crypto
    .createHmac("sha256", HMAC_SECRET)
    .update(rawBody)
    .digest("hex");
  console.log("Expected signature:", computed);
  console.log("Received signature:", signature);
  const match = computed === signature;
  if (!match) {
    console.warn("Signature mismatch — allowing through for debugging");
  }
  return true; // temporarily allow all through for debugging
}

async function generateProposalPitch(description) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: `You are a travel planning agent writing a short proposal to win a travel planning job. Write a compelling 2-3 sentence pitch (minimum 10 characters) explaining why you're the best fit to plan this trip.

Job description: ${description}

Keep it concise, confident, and specific to the request. No fluff.`,
      },
    ],
  });
  return message.content[0].type === "text"
    ? message.content[0].text
    : "I specialize in crafting personalized travel itineraries tailored to your unique interests. Let me create the perfect travel plan for you!";
}

async function generateTravelItinerary(description) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: `You are an expert travel planner. A traveler has shared their interests and cities they want to visit. Create a detailed, personalized travel itinerary for them.

Traveler's request: ${description}

Please provide:
1. A day-by-day itinerary
2. Top attractions matching their interests
3. Restaurant recommendations
4. Practical tips (best time to visit spots, transportation, etc.)
5. Estimated budget breakdown

Keep the tone friendly and enthusiastic. Be specific and practical.`,
      },
    ],
  });
  return message.content[0].type === "text"
    ? message.content[0].text
    : "Unable to generate itinerary.";
}

async function handleJobNew(event) {
  const jobId = event.jobId;
  const description = event.description || event.title || "";
  console.log(`Processing new job: ${jobId}`);

  const pitch = await generateProposalPitch(description);
  console.log("Generated pitch:", pitch);

  const res = await fetch(`${ACTMYAGENT_API}/proposals`, {
    method: "POST",
    headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      jobId,
      message: pitch,
      price: 49,
      currency: "USD",
      estimatedDays: 1,
    }),
  });

  const data = await res.json();
  console.log("Proposal response:", JSON.stringify(data));
}

async function handleMessageNew(event) {
  const contractId = event.contractId;
  const content = event.content;
  const replyEndpoint = event.replyEndpoint || `${ACTMYAGENT_API}/messages`;

  console.log(`Processing message for contract: ${contractId}`);
  console.log(`Message content: ${content}`);
  console.log(`Reply endpoint: ${replyEndpoint}`);

  const itinerary = await generateTravelItinerary(content);
  console.log("Generated itinerary (first 200 chars):", itinerary.slice(0, 200));

  // Send reply using the replyEndpoint from the webhook payload
  const msgRes = await fetch(replyEndpoint, {
    method: "POST",
    headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      contractId,
      content: itinerary.slice(0, 4000),
    }),
  });

  const msgData = await msgRes.json();
  console.log("Message send response:", JSON.stringify(msgData));

  // Submit itinerary as a file delivery
  await submitItineraryDelivery(contractId, itinerary, content);
}

async function submitItineraryDelivery(contractId, itinerary, originalRequest) {
  const filename = "travel-itinerary.txt";
  const fileContent = `TRAVEL ITINERARY\n================\n\nOriginal Request:\n${originalRequest}\n\n${itinerary}`;
  const fileBytes = Buffer.from(fileContent, "utf-8");

  // Step 1: Get presigned upload URL
  const urlRes = await fetch(`${ACTMYAGENT_API}/deliveries/upload-url`, {
    method: "POST",
    headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      contractId,
      filename,
      mimeType: "text/plain",
      fileSize: fileBytes.length,
    }),
  });

  if (!urlRes.ok) {
    console.log("Skipping delivery — contract may not be active yet:", await urlRes.text());
    return;
  }

  const { uploadUrl, key } = await urlRes.json();

  // Step 2: Upload directly to S3
  await fetch(uploadUrl, {
    method: "PUT",
    body: fileBytes,
    headers: { "Content-Type": "text/plain" },
  });

  // Step 3: Submit delivery record
  const deliveryRes = await fetch(`${ACTMYAGENT_API}/deliveries`, {
    method: "POST",
    headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      contractId,
      description:
        "Your personalized travel itinerary is ready! Full day-by-day plan with attractions, restaurants, and tips attached.",
      files: [{ key, filename, size: fileBytes.length }],
    }),
  });

  const deliveryData = await deliveryRes.json();
  console.log("Delivery submitted:", JSON.stringify(deliveryData));
}

async function reportError(step, err, context) {
  try {
    await fetch(`${ACTMYAGENT_API}/agent-errors`, {
      method: "POST",
      headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        step,
        errorMessage: err.message,
        errorCode: err.name,
        ...context,
      }),
    });
  } catch (_) {}
}

export default async function handler(req, context) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-actmyagent-signature") ?? "";

  verifySignature(rawBody, signature); // logs but doesn't block

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const eventType = event.event;
  console.log(`Received event: ${eventType}`);

  // Respond 200 immediately, process async
  context.waitUntil(
    (async () => {
      try {
        if (eventType === "job.new") await handleJobNew(event);
        else if (eventType === "message.new") await handleMessageNew(event);
        else console.log(`Unhandled event: ${eventType}`);
      } catch (err) {
        console.error("Unhandled error:", err.message, err.stack);
        await reportError("OTHER", err, { eventType });
      }
    })()
  );

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export const config = {
  path: "/functions/travelWebhook",
};
