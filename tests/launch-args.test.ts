import { describe, expect, it } from "vitest";
import { LAUNCH_USAGE, parseLaunchArguments } from "../src/launch-args";

function existsIn(paths: string[]) {
  return (path: string): boolean => paths.includes(path.replace(/\\/gu, "/"));
}

describe("launch arguments", () => {
  it("takes a bare directory as the knowledge base", () => {
    const { requestedRootPath } = parseLaunchArguments(["D:/notes"], existsIn(["D:/notes"]));

    expect(requestedRootPath?.replace(/\\/gu, "/")).toBe("D:/notes");
  });

  it("supports --dir= and -d forms", () => {
    const withEquals = parseLaunchArguments(["--dir=D:/notes"], existsIn(["D:/notes"]));
    const withSpace = parseLaunchArguments(["-d", "D:/notes"], existsIn(["D:/notes"]));

    expect(withEquals.requestedRootPath?.replace(/\\/gu, "/")).toBe("D:/notes");
    expect(withSpace.requestedRootPath?.replace(/\\/gu, "/")).toBe("D:/notes");
  });

  it("accepts a note and opens the folder that contains it", () => {
    const { requestedRootPath } = parseLaunchArguments(
      ["D:/notes/LangGraph/状态.md"],
      existsIn(["D:/notes/LangGraph"])
    );

    expect(requestedRootPath?.replace(/\\/gu, "/")).toBe("D:/notes/LangGraph");
  });

  it("ignores Electron switches and quoted paths", () => {
    const { requestedRootPath, unusableRootPath } = parseLaunchArguments(
      ["--allow-file-access-from-files", '"D:/notes"'],
      existsIn(["D:/notes"])
    );

    expect(requestedRootPath?.replace(/\\/gu, "/")).toBe("D:/notes");
    expect(unusableRootPath).toBeNull();
  });

  it("does not eat a non-path argument after -d", () => {
    const { requestedRootPath } = parseLaunchArguments(["-d", "--verbose"], existsIn([]));

    expect(requestedRootPath).toBeNull();
  });

  it("reports a directory that is not there instead of silently falling back", () => {
    const { requestedRootPath, unusableRootPath } = parseLaunchArguments(
      ["D:/missing"],
      existsIn([])
    );

    expect(requestedRootPath).toBeNull();
    expect(unusableRootPath).toBe("D:/missing");
  });

  it("recognises --help", () => {
    expect(parseLaunchArguments(["--help"], existsIn([])).showHelp).toBe(true);
    expect(LAUNCH_USAGE).toContain("--dir=");
  });

  it("has nothing to open when launched without arguments", () => {
    expect(parseLaunchArguments([], existsIn([]))).toEqual({
      requestedRootPath: null,
      unusableRootPath: null,
      showHelp: false
    });
  });
});
