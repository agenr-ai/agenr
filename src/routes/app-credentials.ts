import { Hono } from "hono";
import { z } from "zod";

import { requireScope } from "../middleware/auth";
import { parseJsonBody } from "../utils/json-body";
import { isValidServiceIdentifier } from "../utils/validation";
import { deleteAppCredential, listAppCredentials, storeAppCredential } from "../vault/app-credential-store";

const upsertAppCredentialSchema = z.object({
  clientId: z.string().trim().min(1).optional(),
  clientSecret: z.string().trim().min(1).optional(),
  client_id: z.string().trim().min(1).optional(),
  client_secret: z.string().trim().min(1).optional(),
});

function normalizeService(service: string): string {
  return service.trim().toLowerCase();
}

export const appCredentialsApp = new Hono();

appCredentialsApp.get("/", requireScope("admin"), async (c) => {
  const credentials = await listAppCredentials();
  return c.json(
    credentials.map((credential) => ({
      service: credential.service,
      created_at: credential.createdAt,
      updated_at: credential.updatedAt,
    })),
  );
});

appCredentialsApp.post("/:service", requireScope("admin"), async (c) => {
  const parsedBody = await parseJsonBody(c);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const parsed = upsertAppCredentialSchema.safeParse(parsedBody.data);
  if (!parsed.success) {
    return c.json(
      {
        error: "Invalid request",
        details: z.treeifyError(parsed.error),
      },
      400,
    );
  }

  const service = normalizeService(c.req.param("service"));
  if (!isValidServiceIdentifier(service)) {
    return c.json({ error: "Invalid service identifier" }, 400);
  }
  const clientId = parsed.data.clientId ?? parsed.data.client_id;
  const clientSecret = parsed.data.clientSecret ?? parsed.data.client_secret;
  if (!clientId || !clientSecret) {
    return c.json(
      {
        error: "Invalid request",
        message: "clientId/clientSecret are required.",
      },
      400,
    );
  }

  await storeAppCredential(service, {
    clientId,
    clientSecret,
  });

  return c.json({ status: "configured", service });
});

appCredentialsApp.delete("/:service", requireScope("admin"), async (c) => {
  const service = normalizeService(c.req.param("service"));
  if (!isValidServiceIdentifier(service)) {
    return c.json({ error: "Invalid service identifier" }, 400);
  }
  await deleteAppCredential(service);
  return c.json({ status: "removed", service });
});
