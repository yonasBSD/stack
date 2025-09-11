import { getEnvVariable } from "@stackframe/stack-shared/dist/utils/env";
import { StackAssertionError, StatusError } from "@stackframe/stack-shared/dist/utils/errors";
import { getJwtInfo } from "@stackframe/stack-shared/dist/utils/jwt";
import { OAuthUserInfo, validateUserInfo } from "../utils";
import { OAuthBaseProvider, TokenSet } from "./base";

export class GithubProvider extends OAuthBaseProvider {
  private constructor(
    ...args: ConstructorParameters<typeof OAuthBaseProvider>
  ) {
    super(...args);
  }

  static async create(options: {
    clientId: string,
    clientSecret: string,
  }) {
    return new GithubProvider(...await OAuthBaseProvider.createConstructorArgs({
      issuer: "https://github.com",
      authorizationEndpoint: "https://github.com/login/oauth/authorize",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      userinfoEndpoint: "https://api.github.com/user",
      redirectUri: getEnvVariable("NEXT_PUBLIC_STACK_API_URL") + "/api/v1/auth/oauth/callback/github",
      baseScope: "user:email",
      // GitHub token does not expire except for lack of use in a year
      // We set a default of 1 year
      // https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation#user-token-expired-due-to-github-app-configuration
      defaultAccessTokenExpiresInMillis: 1000 * 60 * 60 * 8, // 8 hours
      ...options,
    }));
  }

  async postProcessUserInfo(tokenSet: TokenSet): Promise<OAuthUserInfo> {
    const rawUserInfoRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenSet.accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!rawUserInfoRes.ok) {
      throw new StackAssertionError("Error fetching user info from GitHub provider: Status code " + rawUserInfoRes.status, {
        rawUserInfoRes,
        rawUserInfoResText: await rawUserInfoRes.text(),
        hasAccessToken: !!tokenSet.accessToken,
        hasRefreshToken: !!tokenSet.refreshToken,
        accessTokenExpiredAt: tokenSet.accessTokenExpiredAt,
        jwtInfo: await getJwtInfo({ jwt: tokenSet.accessToken }),
      });
    }
    const rawUserInfo = await rawUserInfoRes.json();

    const emailsRes = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${tokenSet.accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!emailsRes.ok) {
      // GitHub returns a 403 error when fetching user emails if the permission "Email addresses" is not set
      // https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app#choosing-permissions-for-rest-api-access
      if (emailsRes.status === 403) {
        throw new StatusError(StatusError.BadRequest, `GitHub returned a 403 error when fetching user emails. \nDeveloper information: This is likely due to not having the correct permission "Email addresses" in your GitHub app. Please check your GitHub app settings and try again.`);
      }
      throw new StackAssertionError("Error fetching user emails from GitHub: Status code " + emailsRes.status, {
        emailsRes,
        rawUserInfo,
      });
    }
    const emails = await emailsRes.json();
    if (!Array.isArray(emails)) {
      throw new StackAssertionError("Error fetching user emails from GitHub: Invalid response", {
        emails,
        emailsRes,
        rawUserInfo,
      });
    }
    const { email, verified } = emails.find((e: any) => e.primary);

    return validateUserInfo({
      accountId: rawUserInfo.id?.toString(),
      displayName: rawUserInfo.name,
      profileImageUrl: rawUserInfo.avatar_url as any,
      email: email,
      emailVerified: verified,
    });
  }

  async checkAccessTokenValidity(accessToken: string): Promise<boolean> {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    return res.ok;
  }
}
