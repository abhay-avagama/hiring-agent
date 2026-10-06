/**
 * A desktop notification, using whatever the machine already has.
 *
 * No dependency and no daemon: each platform ships something that puts a line on screen, and a monitor that runs
 * on your own machine should not need a package to tell you it found something. Failure is silent by design —
 * a missing notifier must never stop a monitor from recording what it found.
 */
const QUOTE = /["\\]/g;

export async function notifyDesktop(title: string, body: string): Promise<boolean> {
  const safeTitle = title.replace(QUOTE, "").slice(0, 120);
  const safeBody = body.replace(QUOTE, "").slice(0, 240);
  const attempts: string[][] = process.platform === "darwin"
    ? [["osascript", "-e", `display notification "${safeBody}" with title "${safeTitle}"`]]
    : process.platform === "win32"
      ? [["powershell", "-NoProfile", "-Command",
          `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null; ` +
          `Write-Output "${safeTitle}: ${safeBody}"`]]
      : [["notify-send", safeTitle, safeBody], ["kdialog", "--passivepopup", `${safeTitle}\n${safeBody}`, "10"]];
  for (const command of attempts) {
    try {
      const proc = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
      if (await proc.exited === 0) return true;
    } catch { /* try the next one, or give up quietly */ }
  }
  return false;
}
