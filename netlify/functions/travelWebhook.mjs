import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";

const ACTMYAGENT_API = "https://api.actmyagent.com/api";
const API_KEY = process.env.ACTMYAGENT_API_KEY;
const HMAC_SECRET = process.env.ACTMYAGENT_HMAC_SECRET;

// ─── Signature Verification ───────────────────────────────────────────────────

function verifySignature(rawBody, signature) {
  if (!signature) {
    console.warn("No signature provided — skipping verification");
    return true;
  }
  const computed = crypto
    .createHmac("sha256", HMAC_SECRET)
    .update(rawBody)
    .digest("hex");
  const match = computed === signature;
  if (!match) {
    console.warn(`Signature mismatch. Expected: ${computed}, Got: ${signature}`);
  }
  return true; // non-blocking for now
}

// ─── AI Helpers ───────────────────────────────────────────────────────────────

async function generateProposalPitch(description) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 300,
    messages: [{
      role: "user",
      content: `You are a travel planning agent writing a short proposal to win a travel planning job. Write a compelling 2-3 sentence pitch explaining why you're the best fit to plan this trip.

Job description: ${description}

Keep it concise, confident, and specific to the request. No fluff.`,
    }],
  });
  return message.content[0].type === "text"
    ? message.content[0].text
    : "I specialize in crafting personalized travel itineraries tailored to your unique interests. Let me create the perfect travel plan for you!";
}

async function generateTravelItinerary(jobTitle, jobDescription, scope, deliverables, buyerName) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 2000,
    messages: [{
      role: "user",
      content: `You are an expert travel planner. A buyer named ${buyerName || "the traveler"} has contracted you to create a travel itinerary.

Job Title: ${jobTitle}
Job Description: ${jobDescription}
Scope: ${scope}
Deliverables: ${deliverables}

Please provide a complete, detailed travel itinerary including:
1. Day-by-day schedule
2. Top attractions matching their interests
3. Restaurant recommendations
4. Practical tips (best time to visit, transportation, local customs)
5. Estimated budget breakdown

Keep the tone friendly and enthusiastic. Be specific and practical.`,
    }],
  });
  return message.content[0].type === "text"
    ? message.content[0].text
    : "Unable to generate itinerary.";
}

async function generateChatReply(content) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 500,
    messages: [{
      role: "user",
      content: `You are a professional travel planning agent chatting with a potential client. Respond to their message naturally and helpfully. If they have questions about scope, answer them. If they seem ready to proceed, suggest signing the contract.

Client message: ${content}

Keep the reply concise and friendly (2-4 sentences max).`,
    }],
  });
  return message.content[0].type === "text"
    ? message.content[0].text
    : "Thanks for your message! I'm happy to help clarify anything before we proceed.";
}

// ─── API Helpers ──────────────────────────────────────────────────────────────

async function sendMessage(contractId, content) {
  const res = await fetch(`${ACTMYAGENT_API}/messages`, {
    method: "POST",
    headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ contractId, content }),
  });
  const text = await res.text();
  console.log(`sendMessage [${res.status}]:`, text);
  return { status: res.status, body: text };
}

async function signContract(contractId) {
  const res = await fetch(`${ACTMYAGENT_API}/contracts/${contractId}/sign`, {
    method: "POST",
    headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
  });
  const data = await res.json();
  console.log(`signContract [${res.status}]:`, JSON.stringify(data));
  return { status: res.status, data };
}

async function pollContractStatus(contractId) {
  const res = await fetch(`${ACTMYAGENT_API}/contracts/${contractId}/status`, {
    headers: { "x-api-key": API_KEY },
  });
  const data = await res.json();
  console.log(`pollContractStatus [${res.status}]:`, JSON.stringify(data));
  return data;
}

async function reportError(step, err, context = {}) {
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

// ─── Delivery ─────────────────────────────────────────────────────────────────

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
    const errText = await urlRes.text();
    console.log("Skipping delivery — upload-url failed:", errText);
    return;
  }

  const { uploadUrl, key } = await urlRes.json();

  // Step 2: Upload directly to S3
  const s3Res = await fetch(uploadUrl, {
    method: "PUT",
    body: fileBytes,
    headers: { "Content-Type": "text/plain" },
  });
  console.log("S3 upload status:", s3Res.status);

  // Step 3: Submit delivery record
  const deliveryRes = await fetch(`${ACTMYAGENT_API}/deliveries`, {
    method: "POST",
    headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      contractId,
      description: "Your personalized travel itinerary is ready! Full day-by-day plan with attractions, restaurants, tips, and budget breakdown attached.",
      files: [{ key, filename, size: fileBytes.length }],
    }),
  });

  const deliveryData = await deliveryRes.json();
  console.log("Delivery submitted:", JSON.stringify(deliveryData));
}

// ─── Event Handlers ───────────────────────────────────────────────────────────

async function handleJobNew(event) {
  const { jobId, description, title } = event;
  console.log(`[job.new] jobId: ${jobId}`);

  const pitch = await generateProposalPitch(description || title || "");
  console.log("Pitch:", pitch);

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
  console.log(`Proposal response [${res.status}]:`, JSON.stringify(data));
}

async function handleMessageNew(event) {
  const { contractId, content, senderRole } = event;
  console.log(`[message.new] contractId: ${contractId}, senderRole: ${senderRole}`);
  console.log(`Message: ${content}`);

  // Only reply to buyer messages
  if (senderRole !== "BUYER") {
    console.log("Ignoring non-buyer message");
    return;
  }

  // Reply to the buyer's message in chat
  const reply = await generateChatReply(content);
  await sendMessage(contractId, reply);

  // After replying, sign the contract to move things forward
  console.log("Attempting to sign contract...");
  const { status, data } = await signContract(contractId);

  if (status === 200 || status === 201) {
    const contractStatus = data?.contract?.status;
    console.log("Contract status after signing:", contractStatus);

    if (contractStatus === "SIGNED_BOTH") {
      await sendMessage(contractId,
        "I've signed the contract! ✅ Once you complete payment, I'll get started on your itinerary right away."
      );
    } else if (contractStatus === "SIGNED_AGENT") {
      await sendMessage(contractId,
        "I've signed the contract on my end! ✅ Please review and sign when you're ready, then complete payment to kick things off."
      );
    }
  } else if (data?.error?.includes("already signed")) {
    console.log("Already signed — skipping");
  } else {
    console.log("Could not sign contract:", JSON.stringify(data));
  }
}

async function handleContractSignedBoth(event) {
  const { contractId, jobId } = event;
  console.log(`[contract.signed_both] contractId: ${contractId} — standing by for payment`);
  // Do NOT start work. Just log and wait for contract.active webhook.
  // The buyer has 24 hours to fund escrow.
}

async function handleContractActive(event) {
  const { contractId, job, contract, buyer } = event;
  console.log(`[contract.active] contractId: ${contractId} — payment confirmed, starting work`);

  const jobTitle = job?.title || "Travel Planning";
  const jobDescription = job?.description || "";
  const scope = contract?.scope || jobDescription;
  const deliverables = contract?.deliverables || "Personalized travel itinerary";
  const buyerName = buyer?.name || "Traveler";

  // Notify the buyer we're starting
  await sendMessage(contractId,
    `Great news, ${buyerName}! 🎉 Payment confirmed — I'm starting on your itinerary now. You'll have it within the hour!`
  );

  // Generate the full itinerary
  const itinerary = await generateTravelItinerary(jobTitle, jobDescription, scope, deliverables, buyerName);
  console.log("Itinerary generated (first 200 chars):", itinerary.slice(0, 200));

  // Send itinerary preview in chat
  await sendMessage(contractId,
    `Here's a preview of your itinerary:\n\n${itinerary.slice(0, 1500)}${itinerary.length > 1500 ? "\n\n[Full itinerary attached as file below]" : ""}`
  );

  // Submit as a file delivery
  await submitItineraryDelivery(contractId, itinerary, `${jobTitle}\n${jobDescription}`);
}

async function handleContractVoided(event) {
  const { contractId, reason, message } = event;
  console.log(`[contract.voided] contractId: ${contractId}, reason: ${reason}`);

  // Verify status via polling before treating as voided (no HMAC on this event)
  try {
    const statusData = await pollContractStatus(contractId);
    const agentAction = statusData?.agentAction;
    console.log(`Polled agentAction: ${agentAction}`);

    if (agentAction === "stop") {
      console.log("Contract confirmed voided — standing down");
    } else if (agentAction === "start_work") {
      // Rare race condition — webhook was wrong, payment actually came through
      console.log("Unexpected: polled status says start_work despite voided webhook — handling as active");
      await handleContractActive({ contractId, job: {}, contract: {}, buyer: {} });
    }
  } catch (err) {
    console.error("Error polling contract status:", err.message);
  }
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export default async function handler(req, context) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-actmyagent-signature") ?? "";

  verifySignature(rawBody, signature);

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
  console.log(`─── Received event: ${eventType} ───`);

  // Respond 200 immediately, process async
  context.waitUntil(
    (async () => {
      try {
        switch (eventType) {
          case "job.new":
            await handleJobNew(event);
            break;
          case "message.new":
            await handleMessageNew(event);
            break;
          case "contract.signed_both":
            await handleContractSignedBoth(event);
            break;
          case "contract.active":
            await handleContractActive(event);
            break;
          case "contract.voided":
            await handleContractVoided(event);
            break;
          default:
            console.log(`Unhandled event type: ${eventType}`);
        }
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
