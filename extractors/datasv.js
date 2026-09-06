const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT = 10000; // 10 seconds
const MAX_RETRIES = 2;
const RETRY_DELAY = 1000; // 1 second

export function canExtractDataSv(url) {
  return /play\.echovideo\.ru\/embed-20\//i.test(String(url));
}

/**
 * Extracts DATASV sources from an embed URL with improved error handling and retries.
 * @param {string} embedUrl - The embed URL to extract from
 * @param {Object} options - Configuration options
 * @param {Function} options.fetchImpl - Custom fetch implementation
 * @param {string} options.userAgent - Custom user agent string
 * @param {number} options.timeout - Request timeout in milliseconds
 * @param {number} options.maxRetries - Maximum number of retry attempts
 * @returns {Promise<Array>} Array of valid video sources
 * @throws {Error} If extraction fails or no valid sources found
 */
export async function extractDataSv(
  embedUrl,
  {
    fetchImpl = fetch,
    userAgent = DEFAULT_USER_AGENT,
    timeout = DEFAULT_TIMEOUT,
    maxRetries = MAX_RETRIES,
  } = {}
) {
  const url = new URL(String(embedUrl));
  const id = url.pathname.match(/^\/embed-20\/([^/]+)$/i)?.[1];

  if (!id) {
    throw new Error(`Cannot extract DATASV id from ${embedUrl}`);
  }

  const endpoint = new URL("/embed-20/getSources", url.origin);
  endpoint.searchParams.set("id", id);

  // Fetch with retries
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const data = await fetchWithTimeout(
        () =>
          fetchImpl(endpoint, {
            headers: {
              "User-Agent": userAgent,
              "Referer": embedUrl,
              "X-Requested-With": "XMLHttpRequest",
            },
          }),
        timeout
      );

      if (!data.ok) {
        throw new Error(`DATASV sources HTTP ${data.status}`);
      }

      const response = await data.json().catch((err) => {
        throw new Error(`Invalid JSON response: ${err.message}`);
      });

      const sources = parseSources(response, embedUrl);
      if (!sources.length) {
        throw new Error("No sources found in DATASV response");
      }

      const valid = await validateSources(sources, userAgent, url.origin, fetchImpl, timeout);
      if (!valid.length) {
        throw new Error("DATASV response has no available sources");
      }

      return valid;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        await delay(RETRY_DELAY);
      }
    }
  }

  throw new Error(`Failed to extract DATASV sources after ${maxRetries + 1} attempts: ${lastError.message}`);
}

/**
 * Parses source URLs from DATASV response
 * @param {Object} data - The API response data
 * @param {string} embedUrl - Original embed URL for validation
 * @returns {Array} Array of source objects with url, type, and quality
 */
function parseSources(data, embedUrl) {
  const sources = [];

  if (!data?.sources || typeof data.sources !== "object") {
    return sources;
  }

  for (const [quality, urls] of Object.entries(data.sources)) {
    // Validate quality string
    if (!quality || typeof quality !== "string") continue;

    const urlArray = Array.isArray(urls) ? urls : [urls];
    for (const source of urlArray) {
      if (typeof source === "string" && source.trim()) {
        try {
          // Validate that source is a valid URL
          new URL(source);
          sources.push({
            url: source,
            type: "mp4",
            quality: quality.trim(),
          });
        } catch {
          // Skip invalid URLs silently
          continue;
        }
      }
    }
  }

  return sources;
}

/**
 * Validates that video sources are accessible
 * @param {Array} sources - Array of source objects
 * @param {string} userAgent - User agent string
 * @param {string} origin - Request origin
 * @param {Function} fetchImpl - Fetch implementation
 * @param {number} timeout - Request timeout
 * @returns {Promise<Array>} Array of valid, accessible sources
 */
async function validateSources(sources, userAgent, origin, fetchImpl, timeout) {
  const checks = sources.map((source) =>
    checkSourceAvailability(source, userAgent, origin, fetchImpl, timeout).catch(() => null)
  );

  const available = await Promise.all(checks);
  return available.filter(Boolean);
}

/**
 * Checks if a single source URL is accessible
 * @param {Object} source - Source object with url, type, quality
 * @param {string} userAgent - User agent string
 * @param {string} origin - Request origin
 * @param {Function} fetchImpl - Fetch implementation
 * @param {number} timeout - Request timeout
 * @returns {Promise<Object|null>} Source object if available, null otherwise
 */
async function checkSourceAvailability(source, userAgent, origin, fetchImpl, timeout) {
  try {
    const check = await fetchWithTimeout(
      () =>
        fetchImpl(source.url, {
          method: "HEAD",
          headers: {
            "User-Agent": userAgent,
            "Referer": `${origin}/`,
          },
        }),
      timeout
    );

    return check.ok ? source : null;
  } catch {
    return null;
  }
}

/**
 * Wraps fetch with timeout
 * @param {Function} fetchFn - Function that returns a fetch promise
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise} Fetch promise with timeout
 */
function fetchWithTimeout(fetchFn, timeout) {
  return Promise.race([
    fetchFn(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Request timeout after ${timeout}ms`)), timeout)
    ),
  ]);
}

/**
 * Utility delay function
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
