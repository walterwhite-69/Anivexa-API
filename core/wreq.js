const sessions = new Map();

function sessionKey(name, browser, os) {
  return `${name}:${browser}:${os}`;
}

async function getSession(name, browser, os) {
  const key = sessionKey(name, browser, os);
  let current = sessions.get(key);
  if (!current) {
    current = import("wreq-js")
      .then(({ createSession }) => createSession({ browser, os }))
      .catch((error) => {
        sessions.delete(key);
        throw error;
      });
    sessions.set(key, current);
  }
  return current;
}

export async function wreqFetch(url, options = {}) {
  const {
    session = "default",
    browser = "chrome_149",
    os = "windows",
    warm = [],
    ...request
  } = options;
  const client = await getSession(session, browser, os);
  for (const item of warm) {
    await client.fetch(item.url, {
      method: item.method ?? "GET",
      headers: item.headers,
      body: item.body,
      redirect: item.redirect ?? "follow",
    });
  }
  return client.fetch(url, request);
}

export async function closeWreqSessions() {
  const active = [...sessions.values()];
  sessions.clear();
  await Promise.all(active.map(async (current) => {
    const client = await current;
    await client.close();
  }));
}
