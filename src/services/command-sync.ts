import type { Client } from "discord.js";
import type { Logger } from "../logger.js";
import type { CommandRegistry } from "../types.js";

export class CommandSyncer {
  private inFlight: Promise<number> | null = null;

  public constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly commands: CommandRegistry,
    private readonly logger: Logger,
  ) {}

  public sync(reason: string): Promise<number> {
    if (this.inFlight) {
      return this.inFlight;
    }

    const run = this.perform(reason).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async perform(reason: string): Promise<number> {
    const guild = await this.client.guilds.fetch(this.guildId);
    const body = [...this.commands.values()].map((command) => command.data.toJSON());
    const registered = await guild.commands.set(body);

    this.logger.info("Guild commands registered", {
      count: registered.size,
      guildId: guild.id,
      reason,
    });

    return registered.size;
  }
}
