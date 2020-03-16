import Command from "@oclif/command";
import * as Parser from "@oclif/parser";
import chalk from "chalk";
import cli from "cli-ux";
import { toError } from "fp-ts/lib/Either";
import { TaskEither, tryCatch } from "fp-ts/lib/TaskEither";
// tslint:disable-next-line: no-submodule-imports
import { getRequiredStringEnv } from "io-functions-commons/dist/src/utils/env";
import fetch from "node-fetch";

export class Keys extends Command {
  public static description = "Get subscription keys associated to service";

  // tslint:disable-next-line: readonly-array
  public static examples = [`$ io-ops api-service:keys SERVICEID`];

  // tslint:disable-next-line: readonly-array
  public static args: Parser.args.IArg[] = [
    {
      description: "id of the service",
      name: "serviceId",
      required: true
    }
  ];

  public async run(): Promise<void> {
    // can get args as an object
    const { args } = this.parse(Keys);
    // tslint:disable-next-line: no-console
    cli.action.start(
      chalk.blue.bold(`Getting keys for service ${args.serviceId}`),
      chalk.blueBright.bold("Running"),
      {
        stdout: true
      }
    );
    return this.get(args.serviceId)
      .fold(
        error => {
          cli.action.stop(chalk.red(`Error : ${error}`));
        },
        result => {
          cli.action.stop(chalk.green(`Response: ${result}`));
        }
      )
      .run();
  }

  private get = (serviceId: string): TaskEither<Error, string> => {
    return tryCatch(
      () =>
        fetch(
          `${getRequiredStringEnv(
            "BASE_URL_ADMIN"
          )}/services/${serviceId}/keys`,
          {
            headers: {
              "Ocp-Apim-Subscription-Key": getRequiredStringEnv("OCP_APIM")
            }
          }
        ).then(res => res.text()),
      toError
    );
  };
}