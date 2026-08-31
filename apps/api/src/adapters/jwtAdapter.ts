/**
 * Wraps the Fastify JWT decorator in a plain object, so services can sign and
 * verify tokens without holding a reference to the Fastify instance.
 */

/**
 * Signs and verifies the access and refresh tokens for one running server.
 *
 * `tv` is the token version the account had when the token was signed. A
 * password reset raises the account's version, which stops every token signed
 * before it from refreshing. Tokens signed before versioning existed carry no
 * `tv`, so it is optional on the verifying side.
 */
export interface JwtAdapter {
  signAccess: (payload: { sub: string; tv: number }) => string;
  signRefresh: (payload: { sub: string; tv: number }) => string;
  verifyAccess: (token: string) => { sub: string; tv?: number };
  verifyRefresh: (token: string) => { sub: string; tv?: number };
}

export function createJwtAdapter (jwt: {
  signAccess: (payload: { sub: string; tv: number }) => string;
  signRefresh: (payload: { sub: string; tv: number }) => string;
  verifyAccess: (token: string) => { sub: string; tv?: number };
  verifyRefresh: (token: string) => { sub: string; tv?: number };
}): JwtAdapter {
  return {
    signAccess: jwt.signAccess.bind(jwt),
    signRefresh: jwt.signRefresh.bind(jwt),
    verifyAccess: jwt.verifyAccess.bind(jwt),
    verifyRefresh: jwt.verifyRefresh.bind(jwt),
  };
}
