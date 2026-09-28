// Railway Infrastructure as Code for this template.
// Evaluated by `railway config plan` / `railway config apply` (see README, "Deploy without the template").
import { defineRailway, github, service, volume } from "railway/iac";

export default defineRailway((ctx, project) => {
  const data = volume("openfang-volume", { sizeMB: 500 });

  const openfang = service("openfang", {
    source: github("jhacksman/openfang-railway", { branch: "main" }),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    deploy: {
      healthcheckPath: "/_gate/healthz",
      healthcheckTimeout: 300,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
    volumeMounts: { "/data": data },
    env: {
      ADMIN_PASSWORD: {
        description: "Password for the gate login page (12+ chars). Generated on first apply.",
        value: ctx.randomString("admin-password", 24),
      },
      OPENFANG_API_KEY: {
        description: "Bearer token for the OpenFang HTTP/WebSocket API. Generated on first apply.",
        value: ctx.randomString("api-key", 32),
      },
      // Add your provider key here (e.g. ANTHROPIC_API_KEY) or set it in the Railway dashboard.
    },
  });

  return project("openfang", { resources: [openfang, data] });
});
