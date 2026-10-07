import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import Firecrawl from '@mendable/firecrawl-js';

// The web example's tools, moved server-side unchanged from autonomous-chatbot's
// src/routes/api/chat/+server.ts so the CLI gets them too. Each one is
// registered only when its key is set; a missing key is logged at startup.

// Firecrawl response types
interface FirecrawlSearchResult {
  title?: string;
  description?: string;
  url?: string;
  markdown?: string;
  links?: string[];
  metadata?: {
    title?: string;
    description?: string;
    sourceURL?: string;
    statusCode?: number;
  };
}

/**
 * Firecrawl 4.x (its v2 API) returns results under `web`; there is no
 * `success`/`data` envelope any more. Each item is a plain result, or a scraped
 * document when `scrapeOptions` asks for content.
 */
interface FirecrawlSearchResponse {
  web?: FirecrawlSearchResult[];
}

/** autonomous-chatbot's system prompt, used for the web endpoint. */
export const WEB_SYSTEM_PROMPT = `You are a helpful and friendly chatbot assistant. Provide concise and helpful responses to user queries.
			You can use the weather tool to provide current weather information when users ask about weather conditions.
			You will always use the search tool to find current information, news, or any web content when users ask questions that require up-to-date information.
			Always use the tools when relevant and don't rely on your memory when asked about current events or specific information most of the times, and provide clear and concise responses to the user.`;

function weatherTool(apiKey: string) {
  return tool({
    description:
      'Get current weather information for a specific location using latitude and longitude coordinates',
    inputSchema: z.object({
      latitude: z.number().min(-90).max(90).describe('The latitude of the location (between -90 and 90)'),
      longitude: z
        .number()
        .min(-180)
        .max(180)
        .describe('The longitude of the location (between -180 and 180)'),
    }),
    execute: async ({ latitude, longitude }) => {
      const url = `https://api.openweathermap.org/data/2.5/weather?lat=${latitude}&lon=${longitude}&units=metric&appid=${apiKey}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`OpenWeatherMap API error: ${response.statusText}`);
      }

      const data = await response.json();

      return {
        location: { latitude, longitude },
        weather: {
          temperature: `${data.main.temp}°C`,
          feels_like: `${data.main.feels_like}°C`,
          condition: data.weather[0].description,
          humidity: `${data.main.humidity}%`,
          pressure: `${data.main.pressure} hPa`,
          wind_speed: `${data.wind.speed} m/s`,
          cloud_coverage: `${data.clouds.all}%`,
        },
      };
    },
  });
}

function searchTool(apiKey: string) {
  const firecrawl = new Firecrawl({ apiKey });
  return tool({
    description:
      'Search the web and retrieve content from search results. Use this to find current information, news, documentation, or any web content.',
    inputSchema: z.object({
      query: z.string().describe('The search query to find relevant web content'),
      limit: z
        .number()
        .min(1)
        .max(10)
        .default(3)
        .describe('Number of search results to return (1-10, default 3)'),
    }),
    execute: async ({ query, limit = 3 }) => {
      const response = (await firecrawl.search(query, {
        limit,
        scrapeOptions: { formats: ['markdown'] },
      })) as unknown as FirecrawlSearchResponse;

      if (!Array.isArray(response?.web)) {
        throw new Error('Search failed: unexpected response from Firecrawl');
      }

      return {
        query,
        results: response.web.map((item) => ({
          title: item.title ?? item.metadata?.title,
          url: item.url ?? item.metadata?.sourceURL,
          description: item.description ?? item.metadata?.description,
          content: item.markdown?.substring(0, 2000), // Limit content length
        })),
      };
    },
  });
}

/** The built-in tools whose keys are present, plus a line per tool for logs. */
export function builtinTools(env = process.env): { tools: ToolSet; report: string[] } {
  const tools: ToolSet = {};
  const report: string[] = [];

  if (env.OPENWEATHERMAP_API_KEY) {
    tools.weather = weatherTool(env.OPENWEATHERMAP_API_KEY);
    report.push('  ✓ tool weather (OpenWeatherMap)');
  } else {
    report.push('  · tool weather skipped: OPENWEATHERMAP_API_KEY not set');
  }

  if (env.FIRECRAWL_API_KEY) {
    tools.search = searchTool(env.FIRECRAWL_API_KEY);
    report.push('  ✓ tool search (Firecrawl)');
  } else {
    report.push('  · tool search skipped: FIRECRAWL_API_KEY not set');
  }

  return { tools, report };
}
