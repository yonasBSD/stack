import { it } from "../../../../../helpers";
import { Auth, InternalProjectClientKeys, Project, backendContext, niceBackendFetch } from "../../../../backend-helpers";


it("should not have have access to the project", async ({ expect }) => {
  backendContext.set({ projectKeys: 'no-project' });
  const response1 = await niceBackendFetch("/api/v1/internal/projects", { accessType: "client" });
  expect(response1).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "ACCESS_TYPE_WITHOUT_PROJECT_ID",
        "details": { "request_type": "client" },
        "error": deindent\`
          The x-stack-access-type header was 'client', but the x-stack-project-id header was not provided.
          
          For more information, see the docs on REST API authentication: https://docs.stack-auth.com/rest-api/overview#authentication
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "ACCESS_TYPE_WITHOUT_PROJECT_ID",
        <some fields may have been hidden>,
      },
    }
  `);
});


it("is not allowed to list all current projects without signing in", async ({ expect }) => {
  const response = await niceBackendFetch("/api/v1/internal/projects", { accessType: "client" });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 401,
      "body": {
        "code": "USER_AUTHENTICATION_REQUIRED",
        "error": "User authentication required for this endpoint.",
      },
      "headers": Headers {
        "x-stack-known-error": "USER_AUTHENTICATION_REQUIRED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("lists all current projects (empty list)", async ({ expect }) => {
  await Auth.Otp.signIn();
  const response = await niceBackendFetch("/api/v1/internal/projects", { accessType: "client" });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("creates a new project", async ({ expect }) => {
  backendContext.set({ projectKeys: InternalProjectClientKeys });
  await Auth.Otp.signIn();
  const result = await Project.createAndGetAdminToken({
    display_name: "Test Project",
  });
  expect(result.createProjectResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
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
          "enabled_oauth_providers": [],
          "magic_link_enabled": false,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [],
          "passkey_enabled": false,
          "sign_up_enabled": true,
          "team_creator_default_permissions": [{ "id": "team_admin" }],
          "team_member_default_permissions": [{ "id": "team_member" }],
          "user_default_permissions": [],
        },
        "created_at_millis": <stripped field 'created_at_millis'>,
        "description": "",
        "display_name": "Test Project",
        "id": "<stripped UUID>",
        "is_production_mode": false,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("creates a new project with different configurations", async ({ expect }) => {
  backendContext.set({ projectKeys: InternalProjectClientKeys });
  await Auth.Otp.signIn();
  const { createProjectResponse: response1 } = await Project.create({
    display_name: "Test Project",
    description: "Test description",
    is_production_mode: true,
    config: {
      allow_localhost: false,
      sign_up_enabled: false,
      credential_enabled: false,
      magic_link_enabled: true,
    },
  });
  expect(response1).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
      "body": {
        "config": {
          "allow_localhost": false,
          "allow_team_api_keys": false,
          "allow_user_api_keys": false,
          "client_team_creation_enabled": false,
          "client_user_deletion_enabled": false,
          "create_team_on_sign_up": false,
          "credential_enabled": false,
          "domains": [],
          "email_config": { "type": "shared" },
          "email_theme": "<stripped UUID>",
          "enabled_oauth_providers": [],
          "magic_link_enabled": true,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [],
          "passkey_enabled": false,
          "sign_up_enabled": false,
          "team_creator_default_permissions": [{ "id": "team_admin" }],
          "team_member_default_permissions": [{ "id": "team_member" }],
          "user_default_permissions": [],
        },
        "created_at_millis": <stripped field 'created_at_millis'>,
        "description": "Test description",
        "display_name": "Test Project",
        "id": "<stripped UUID>",
        "is_production_mode": true,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // create with oauth providers
  const { createProjectResponse: response2 } = await Project.create({
    display_name: "Test Project",
    config: {
      oauth_providers: [
        {
          id: "google",
          type: "shared",
        }
      ]
    },
  });
  expect(response2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
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
          "enabled_oauth_providers": [{ "id": "google" }],
          "magic_link_enabled": false,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [
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
        "description": "",
        "display_name": "Test Project",
        "id": "<stripped UUID>",
        "is_production_mode": false,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // create with shared email config
  const { createProjectResponse: response3 } = await Project.create({
    display_name: "Test Project",
    config: {
      email_config: {
        type: "shared",
      },
    },
  });
  expect(response3).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
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
          "enabled_oauth_providers": [],
          "magic_link_enabled": false,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [],
          "passkey_enabled": false,
          "sign_up_enabled": true,
          "team_creator_default_permissions": [{ "id": "team_admin" }],
          "team_member_default_permissions": [{ "id": "team_member" }],
          "user_default_permissions": [],
        },
        "created_at_millis": <stripped field 'created_at_millis'>,
        "description": "",
        "display_name": "Test Project",
        "id": "<stripped UUID>",
        "is_production_mode": false,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // create with standard email config
  const { createProjectResponse: response4 } = await Project.create({
    display_name: "Test Project",
    config: {
      email_config: {
        type: "standard",
        host: "smtp.example.com",
        port: 587,
        username: "test username",
        password: "test password",
        sender_name: "Test Sender",
        sender_email: "test@email.com",
      },
    },
  });
  expect(response4).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
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
          "email_config": {
            "host": "smtp.example.com",
            "password": "test password",
            "port": 587,
            "sender_email": "test@email.com",
            "sender_name": "Test Sender",
            "type": "standard",
            "username": "test username",
          },
          "email_theme": "<stripped UUID>",
          "enabled_oauth_providers": [],
          "magic_link_enabled": false,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [],
          "passkey_enabled": false,
          "sign_up_enabled": true,
          "team_creator_default_permissions": [{ "id": "team_admin" }],
          "team_member_default_permissions": [{ "id": "team_member" }],
          "user_default_permissions": [],
        },
        "created_at_millis": <stripped field 'created_at_millis'>,
        "description": "",
        "display_name": "Test Project",
        "id": "<stripped UUID>",
        "is_production_mode": false,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // create with domains
  const { createProjectResponse: response5 } = await Project.create({
    display_name: "Test Project",
    config: {
      domains: [
        {
          domain: 'https://domain1.com',
          handler_path: '/handler1'
        },
        {
          domain: 'https://domain2.com',
          handler_path: '/handler2'
        }
      ]
    },
  });
  expect(response5).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
      "body": {
        "config": {
          "allow_localhost": true,
          "allow_team_api_keys": false,
          "allow_user_api_keys": false,
          "client_team_creation_enabled": false,
          "client_user_deletion_enabled": false,
          "create_team_on_sign_up": false,
          "credential_enabled": true,
          "domains": [
            {
              "domain": "https://domain1.com",
              "handler_path": "/handler1",
            },
            {
              "domain": "https://domain2.com",
              "handler_path": "/handler2",
            },
          ],
          "email_config": { "type": "shared" },
          "email_theme": "<stripped UUID>",
          "enabled_oauth_providers": [],
          "magic_link_enabled": false,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [],
          "passkey_enabled": false,
          "sign_up_enabled": true,
          "team_creator_default_permissions": [{ "id": "team_admin" }],
          "team_member_default_permissions": [{ "id": "team_member" }],
          "user_default_permissions": [],
        },
        "created_at_millis": <stripped field 'created_at_millis'>,
        "description": "",
        "display_name": "Test Project",
        "id": "<stripped UUID>",
        "is_production_mode": false,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("lists the current projects after creating a new project", async ({ expect }) => {
  await Auth.Otp.signIn();
  await Project.create();
  const response = await niceBackendFetch("/api/v1/internal/projects", { accessType: "client" });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [
          {
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
              "enabled_oauth_providers": [],
              "magic_link_enabled": false,
              "oauth_account_merge_strategy": "link_method",
              "oauth_providers": [],
              "passkey_enabled": false,
              "sign_up_enabled": true,
              "team_creator_default_permissions": [{ "id": "team_admin" }],
              "team_member_default_permissions": [{ "id": "team_member" }],
              "user_default_permissions": [],
            },
            "created_at_millis": <stripped field 'created_at_millis'>,
            "description": "",
            "display_name": "New Project",
            "id": "<stripped UUID>",
            "is_production_mode": false,
          },
        ],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("verifies email_theme update persists", async ({ expect }) => {
  await Project.createAndSwitch();
  const patchResponse = await niceBackendFetch("/api/v1/internal/projects/current", {
    method: "PATCH",
    accessType: "admin",
    body: {
      config: {
        email_theme: "a0172b5d-cff0-463b-83bb-85124697373a" // default-dark
      }
    }
  });
  expect(patchResponse).toMatchInlineSnapshot(`
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
          "enabled_oauth_providers": [],
          "magic_link_enabled": false,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [],
          "passkey_enabled": false,
          "sign_up_enabled": true,
          "team_creator_default_permissions": [{ "id": "team_admin" }],
          "team_member_default_permissions": [{ "id": "team_member" }],
          "user_default_permissions": [],
        },
        "created_at_millis": <stripped field 'created_at_millis'>,
        "description": "",
        "display_name": "New Project",
        "id": "<stripped UUID>",
        "is_production_mode": false,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const response = await niceBackendFetch("/api/v1/internal/projects/current", {
    accessType: "admin"
  });
  expect(response).toMatchInlineSnapshot(`
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
          "enabled_oauth_providers": [],
          "magic_link_enabled": false,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [],
          "passkey_enabled": false,
          "sign_up_enabled": true,
          "team_creator_default_permissions": [{ "id": "team_admin" }],
          "team_member_default_permissions": [{ "id": "team_member" }],
          "user_default_permissions": [],
        },
        "created_at_millis": <stripped field 'created_at_millis'>,
        "description": "",
        "display_name": "New Project",
        "id": "<stripped UUID>",
        "is_production_mode": false,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  expect(response.body.config.email_theme).toBe("a0172b5d-cff0-463b-83bb-85124697373a"); // default-dark
});

it("gives an error when updating email_theme with an invalid value", async ({ expect }) => {
  await Project.createAndSwitch();

  const response = await niceBackendFetch("/api/v1/internal/projects/current", {
    method: "PATCH",
    accessType: "admin",
    body: {
      config: {
        email_theme: "some-invalid-theme",
      }
    }
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Invalid email theme",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});
