// `tv` is the user's tokenVersion at issue time; verify may see tokens minted
// before this claim existed, so it is optional on the read side.
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
