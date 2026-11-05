export type MaintenanceSource = "off" | "local" | "website";

export class BotState {
  public readonly startedAt = new Date();
  public commandsServed = 0;
  public lastCommandAt: Date | null = null;

  private localMaintenance = false;
  private websiteMaintenance: boolean | null = null;

  /**
   * Effective maintenance state. A website heartbeat override wins over the
   * owner's local toggle so the site can close the gate during an incident.
   */
  public get maintenance(): boolean {
    return this.websiteMaintenance ?? this.localMaintenance;
  }

  public get maintenanceSource(): MaintenanceSource {
    if (this.websiteMaintenance !== null) {
      return "website";
    }
    return this.localMaintenance ? "local" : "off";
  }

  public get localMaintenanceEnabled(): boolean {
    return this.localMaintenance;
  }

  public setLocalMaintenance(enabled: boolean): void {
    this.localMaintenance = enabled;
  }

  /**
   * Applies the website's maintenance value. `null` means the website has no
   * override, so the local toggle becomes effective again.
   * Returns true when the effective override changed.
   */
  public setWebsiteMaintenance(value: boolean | null): boolean {
    if (this.websiteMaintenance === value) {
      return false;
    }
    this.websiteMaintenance = value;
    return true;
  }

  public recordCommand(): void {
    this.commandsServed += 1;
    this.lastCommandAt = new Date();
  }

  public uptimeSeconds(now = Date.now()): number {
    return Math.max(0, Math.floor((now - this.startedAt.getTime()) / 1000));
  }
}
