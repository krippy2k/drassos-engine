import { defineApp, ScriptedModelProvider, tool, workflow } from "@drassos/engine";
import { z } from "zod";

export const demoState = {
  searches: 0,
  details: 0,
  menus: 0,
};

export function resetDemoState(): void {
  demoState.searches = 0;
  demoState.details = 0;
  demoState.menus = 0;
}

const restaurants = [
  {
    id: "rest_harbor",
    name: "Harbor Table",
    cuisine: "seafood",
    neighborhood: "waterfront",
    price: "$$",
  },
  {
    id: "rest_cedar",
    name: "Cedar Room",
    cuisine: "vegetarian",
    neighborhood: "midtown",
    price: "$$$",
  },
];

const menus: Record<string, Array<{ item: string; price: number; vegetarian: boolean }>> = {
  rest_harbor: [
    { item: "Grilled salmon", price: 28, vegetarian: false },
    { item: "Clam chowder", price: 12, vegetarian: false },
  ],
  rest_cedar: [
    { item: "Roasted squash risotto", price: 24, vegetarian: true },
    { item: "Seasonal salad", price: 14, vegetarian: true },
  ],
};

export const searchRestaurants = tool({
  name: "searchRestaurants",
  description: "Search restaurants in a city",
  input: z.object({
    city: z.string(),
    partySize: z.number().optional(),
    vegetarian: z.boolean().optional(),
  }),
  handler: async ({ city, vegetarian }) => {
    demoState.searches += 1;
    const matches = vegetarian ? restaurants.filter((item) => item.id === "rest_cedar") : restaurants;
    return { city, restaurants: matches };
  },
});

export const getRestaurantDetails = tool({
  name: "getRestaurantDetails",
  description: "Get restaurant details",
  input: z.object({ restaurantId: z.string() }),
  handler: async ({ restaurantId }) => {
    demoState.details += 1;
    return restaurants.find((item) => item.id === restaurantId) ?? null;
  },
});

export const getMenu = tool({
  name: "getMenu",
  description: "Get a restaurant menu",
  input: z.object({ restaurantId: z.string() }),
  output: z.object({
    restaurantId: z.string(),
    items: z.array(z.object({ item: z.string(), price: z.number(), vegetarian: z.boolean() })),
  }),
  handler: async ({ restaurantId }) => {
    demoState.menus += 1;
    return { restaurantId, items: menus[restaurantId] ?? [] };
  },
});

export const recommendationSchema = z.object({
  restaurantId: z.string(),
  reasoning: z.string(),
  confidence: z.number(),
});

export function createRestaurantProvider(): ScriptedModelProvider {
  return new ScriptedModelProvider(
    [
      {
        toolCalls: [{ id: "t1", name: "searchRestaurants", arguments: { city: "Portland", vegetarian: true } }],
      },
      {
        toolCalls: [{ id: "t2", name: "getRestaurantDetails", arguments: { restaurantId: "rest_cedar" } }],
      },
      {
        toolCalls: [{ id: "t3", name: "getMenu", arguments: { restaurantId: "rest_cedar" } }],
      },
      {
        output: {
          restaurantId: "rest_cedar",
          reasoning: "Cedar Room has vegetarian plates that fit the group.",
          confidence: 0.91,
        },
      },
    ],
    "scripted",
  );
}

export interface RestaurantInput {
  city: string;
  partySize: number;
  vegetarian?: boolean;
}

export const restaurantResearch = workflow<RestaurantInput, unknown>(
  "restaurant-research",
  async (ctx) => {
    const recommendation = await ctx.agent("researchRestaurant", {
      model: "scripted:demo",
      prompt: `Find a restaurant in ${ctx.input.city} for ${ctx.input.partySize} people.${ctx.input.vegetarian ? " Prefer vegetarian." : ""}`,
      tools: ["searchRestaurants", "getRestaurantDetails", "getMenu"],
      output: recommendationSchema,
      maxTurns: 10,
      maxToolCalls: 20,
      timeout: "5m",
      input: ctx.input,
    });
    const saved = await ctx.step("save-result", async () => recommendation);
    return saved;
  },
);

export function createRestaurantApp() {
  return defineApp({
    workflows: [restaurantResearch],
    tools: [searchRestaurants, getRestaurantDetails, getMenu],
    models: { scripted: createRestaurantProvider() },
  });
}

export default createRestaurantApp();

