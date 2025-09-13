import { decryptValue, hashKey } from "@stackframe/stack-shared/dist/helpers/vault/client-side";
import { it } from "../../../../../../../helpers";
import { Auth, InternalApiKey, InternalProjectKeys, Project, backendContext, niceBackendFetch } from "../../../../../../backend-helpers";

export async function provisionProject() {
  return await niceBackendFetch("/api/v1/integrations/neon/projects/provision", {
    method: "POST",
    body: {
      display_name: "Test project",
    },
    headers: {
      "Authorization": "Basic bmVvbi1sb2NhbDpuZW9uLWxvY2FsLXNlY3JldA==",
    },
  });
}

it("should be able to provision a new project if neon client details are correct", async ({ expect }) => {
  const response = await provisionProject();
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "project_id": "<stripped UUID>",
        "super_secret_admin_key": <stripped field 'super_secret_admin_key'>,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);


  // test API keys
  backendContext.set({
    projectKeys: {
      projectId: response.body.project_id,
      superSecretAdminKey: response.body.super_secret_admin_key,
    },
  });
  const project = await niceBackendFetch(`/api/v1/internal/projects/current`, {
    method: "GET",
    accessType: "admin",
  });
  expect(project).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "config": {
          "allow_localhost": true,
          "allow_team_api_keys": false,
          "allow_user_api_keys": false,
          "client_team_creation_enabled": false,
          "client_user_deletion_enabled": false,
          "create_team_on_sign_up": false,
          "credential_enabled": true,
          "domains": [],
          "email_config": { "type": "shared" },
          "email_theme": "<stripped UUID>",
          "enabled_oauth_providers": [
            { "id": "github" },
            { "id": "google" },
          ],
          "magic_link_enabled": false,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [
            {
              "id": "github",
              "provider_config_id": "github",
              "type": "shared",
            },
            {
              "id": "google",
              "provider_config_id": "google",
              "type": "shared",
            },
          ],
          "passkey_enabled": false,
          "sign_up_enabled": true,
          "team_creator_default_permissions": [{ "id": "team_admin" }],
          "team_member_default_permissions": [{ "id": "team_member" }],
          "user_default_permissions": [],
        },
        "created_at_millis": <stripped field 'created_at_millis'>,
        "description": "Created with Neon",
        "display_name": "Test project",
        "full_logo_url": null,
        "id": "<stripped UUID>",
        "is_production_mode": false,
        "logo_url": null,
        "owner_team_id": null,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // create publishable client key and secret server key
  const apiKeyCreationResponse = await InternalApiKey.createAndSetProjectKeys();
  expect(apiKeyCreationResponse.createApiKeyResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "created_at_millis": <stripped field 'created_at_millis'>,
        "description": "test api key",
        "expires_at_millis": <stripped field 'expires_at_millis'>,
        "id": "<stripped UUID>",
        "publishable_client_key": <stripped field 'publishable_client_key'>,
        "secret_server_key": <stripped field 'secret_server_key'>,
        "super_secret_admin_key": <stripped field 'super_secret_admin_key'>,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // ensure we can create a user in the new project (make sure it's writable)
  const signInResponse = await Auth.Password.signUpWithEmail({ password: "test1234" });
  expect(signInResponse).toMatchInlineSnapshot(`
    {
      "email": "default-mailbox--<stripped UUID>@stack-generated.example.com",
      "password": "test1234",
      "signUpResponse": NiceResponse {
        "status": 200,
        "body": {
          "access_token": <stripped field 'access_token'>,
          "refresh_token": <stripped field 'refresh_token'>,
          "user_id": "<stripped UUID>",
        },
        "headers": Headers { <some fields may have been hidden> },
      },
      "userId": "<stripped UUID>",
    }
  `);
});

it("should fail if the neon client details are incorrect", async ({ expect }) => {
  const response = await niceBackendFetch("/api/v1/integrations/neon/projects/provision", {
    method: "POST",
    body: {
      display_name: "Test project",
    },
    headers: {
      "Authorization": "Basic bmVvbi1sb2NhbDpuZW9uLWxvY2FsLXMlY2JldA==",
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on POST /api/v1/integrations/neon/projects/provision:
              - Invalid client_id:client_secret values; did you use the correct values for the integration?
          \`,
        },
        "error": deindent\`
          Request validation failed on POST /api/v1/integrations/neon/projects/provision:
            - Invalid client_id:client_secret values; did you use the correct values for the integration?
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});


it("should fail if the neon client details are missing", async ({ expect }) => {
  const response = await niceBackendFetch("/api/v1/integrations/neon/projects/provision", {
    method: "POST",
    body: {
      display_name: "Test project",
    },
  });
  expect(response).toMatchInlineSnapshot(`
  NiceResponse {
    "status": 400,
    "body": {
      "code": "SCHEMA_ERROR",
      "details": {
        "message": deindent\`
          Request validation failed on POST /api/v1/integrations/neon/projects/provision:
            - headers.authorization must be defined
        \`,
      },
      "error": deindent\`
        Request validation failed on POST /api/v1/integrations/neon/projects/provision:
          - headers.authorization must be defined
      \`,
    },
    "headers": Headers {
      "x-stack-known-error": "SCHEMA_ERROR",
      <some fields may have been hidden>,
    },
  }
`);
});

it("should accept empty connection_strings without attempting migrations", async ({ expect }) => {
  const response = await niceBackendFetch("/api/v1/integrations/neon/projects/provision", {
    method: "POST",
    body: {
      display_name: "Test project",
      connection_strings: [],
    },
    headers: {
      "Authorization": "Basic bmVvbi1sb2NhbDpuZW9uLWxvY2FsLXNlY3JldA==",
    },
  });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    project_id: expect.any(String),
    super_secret_admin_key: expect.any(String),
  });
});

it("should validate connection_strings item shape", async ({ expect }) => {
  const response = await niceBackendFetch("/api/v1/integrations/neon/projects/provision", {
    method: "POST",
    body: {
      display_name: "Test project",
      // missing connection_string in the item
      connection_strings: [
        { branch_id: "main" } as any,
      ],
    },
    headers: {
      "Authorization": "Basic bmVvbi1sb2NhbDpuZW9uLWxvY2FsLXNlY3JldA==",
    },
  });
  expect(response.status).toBe(400);
  expect(response.headers.get("x-stack-known-error")).toBe("SCHEMA_ERROR");
});

it("can provision with a Neon connection string when provided via env (optional)", async ({ expect }) => {
  // this test only runs with a neon connection string set
  const neonConnectionString = process.env.STACK_TEST_NEON_CONNECTION_STRING;
  if (!neonConnectionString) {
    return;
  }

  const response = await niceBackendFetch("/api/v1/integrations/neon/projects/provision", {
    method: "POST",
    body: {
      display_name: "Test project (neon)",
      connection_strings: [
        {
          branch_id: "main",
          connection_string: neonConnectionString,
        },
      ],
    },
    headers: {
      "Authorization": "Basic bmVvbi1sb2NhbDpuZW9uLWxvY2FsLXNlY3JldA==",
    },
  });

  expect(response.status).toBe(200);
  backendContext.set({
    projectKeys: {
      projectId: response.body.project_id,
      superSecretAdminKey: response.body.super_secret_admin_key,
    },
  });

  const configResponse = await niceBackendFetch(`/api/latest/internal/config`, {
    accessType: "admin",
  });
  expect(response.status).toBe(200);
  expect(configResponse.body.config_string).toBeDefined();
  const sourceOfTruth = JSON.parse(configResponse.body.config_string).sourceOfTruth;
  expect(sourceOfTruth).toMatchInlineSnapshot(`
    {
      "connectionStrings": { "main": "<stripped UUID>" },
      "type": "neon",
    }
  `);
  backendContext.set({
    projectKeys: InternalProjectKeys,
  });

  const getConnectionResponse = await niceBackendFetch(`/api/latest/data-vault/stores/neon-connection-strings/get`, {
    method: "POST",
    accessType: "server",
    body: {
      hashed_key: await hashKey("no client side encryption", sourceOfTruth.connectionStrings.main),
    },
  });
  expect(getConnectionResponse.status).toBe(200);
  const connectionString = await decryptValue(
    "no client side encryption",
    sourceOfTruth.connectionStrings.main,
    getConnectionResponse.body.encrypted_value
  );
  expect(connectionString).toBe(neonConnectionString);
});

it("can update the connection_strings for an existing provisioned project", async ({ expect }) => {
  // this test only runs with a neon connection string set
  const neonConnectionString = process.env.STACK_TEST_NEON_CONNECTION_STRING;
  if (!neonConnectionString) {
    return;
  }
  const provisionResponse = await provisionProject();
  const response = await niceBackendFetch(`/api/v1/integrations/neon/projects/connection?project_id=${provisionResponse.body.project_id}`, {
    method: "POST",
    body: {
      connection_strings: [
        { branch_id: "branch1", connection_string: neonConnectionString },
      ],
    },
    headers: {
      "Authorization": "Basic bmVvbi1sb2NhbDpuZW9uLWxvY2FsLXNlY3JldA==",
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "project_id": "<stripped UUID>" },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  backendContext.set({
    projectKeys: {
      projectId: provisionResponse.body.project_id,
      superSecretAdminKey: provisionResponse.body.super_secret_admin_key,
    },
  });
  const configResponse = await niceBackendFetch(`/api/latest/internal/config`, {
    accessType: "admin",
  });
  expect(configResponse.status).toBe(200);
  expect(configResponse.body.config_string).toBeDefined();
  const sourceOfTruth = JSON.parse(configResponse.body.config_string).sourceOfTruth;
  expect(sourceOfTruth).toMatchInlineSnapshot(`
    {
      "connectionStrings": { "branch1": "<stripped UUID>" },
      "type": "neon",
    }
  `);
});
