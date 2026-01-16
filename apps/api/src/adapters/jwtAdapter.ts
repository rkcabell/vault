export interface JwtAdapter {
  signAccess: (payload: { sub: string }) => string;
  signRefresh: (payload: { sub: string }) => string;
  verifyAccess: (token: string) => { sub: string };
  verifyRefresh: (token: string) => { sub: string };
}

export function createJwtAdapter (jwt: {
  signAccess: (payload: { sub: string }) => string;
  signRefresh: (payload: { sub: string }) => string;
  verifyAccess: (token: string) => { sub: string };
  verifyRefresh: (token: string) => { sub: string };
}): JwtAdapter {
  return {
    signAccess: jwt.signAccess.bind(jwt),
    signRefresh: jwt.signRefresh.bind(jwt),
    verifyAccess: jwt.verifyAccess.bind(jwt),
    verifyRefresh: jwt.verifyRefresh.bind(jwt),
  };
}
