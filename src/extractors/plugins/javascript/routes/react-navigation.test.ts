import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { javascriptRouteExtractor } from "./index.js";

const routesOf = async (src: string) => {
  const tree = await parseSource(src, "typescript" as any, "App.tsx");
  return javascriptRouteExtractor.extractRoutes(tree, src, "App.tsx", []).map((r) => `${r.kind} ${r.path} ${r.componentPath ?? "-"}`);
};

describe("React Navigation screens", () => {
  it("reads JSX screens, a render-function child, and the static configuration API", async () => {
    expect(await routesOf(`import { createNativeStackNavigator } from "@react-navigation/native-stack";
const Stack = createNativeStackNavigator();
export const Root = () => (
  <Stack.Navigator>
    <Stack.Screen name="Home" component={HomeScreen} />
    <Stack.Screen name="Chat">{(props) => <ChatScreen {...props} extra />}</Stack.Screen>
    <Stack.Screen name={dynamicName} component={Other} />
  </Stack.Navigator>
);
export const Tabs = createBottomTabNavigator({ screens: { Feed: FeedScreen, Inbox: { screen: InboxScreen }, Search } });`)).toEqual([
      "frontend Home HomeScreen",
      "frontend Chat ChatScreen",
      "frontend Feed FeedScreen",
      "frontend Inbox InboxScreen",
      "frontend Search Search",
    ]);
  });

  it("reads nothing in a file that names no navigator", async () => {
    expect(await routesOf(`const Stack = makeThing(); export const X = () => <Stack.Screen name="A" component={B} />;`)).toEqual([]);
  });
});
