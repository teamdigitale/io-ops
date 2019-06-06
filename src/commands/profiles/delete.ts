import * as cosmos from "@azure/cosmos";
import { Command, flags } from "@oclif/command";
import * as storage from "azure-storage";
import cli from "cli-ux";
import { none, Option, some } from "fp-ts/lib/Option";
import { FiscalCode } from "italia-ts-commons/lib/strings";

import {
  config,
  getCosmosConnection,
  getStorageConnection
} from "../../utils/azure";
import { sequential, sequentialSum } from "../../utils/promise";

type Containers =
  | "profiles"
  | "messages"
  | "message-status"
  | "notifications"
  | "notification-status"
  | "sender-services";

type DeleteOpInner = { containerName: string };
/**
 * define a delete operation
 * a delete operation should have or not related delete operations
 * a related operation is when we have to retrieve items starting from a given set
 * .e.g: the delete operation "messages" has the related delete operation "message-status"
 * because items from "message-status" can be retrieved starting from "message" items
 */
type DeleteOp = {
  containerName: Containers;
  relatedOps: ReadonlyArray<DeleteOpInner>;
  query: string;
  queryParameters: cosmos.SqlParameter[];
  queryOptions?: cosmos.FeedOptions;
  deleteBlobs: boolean;
};

export default class ProfileDelete extends Command {
  static description = "Delete a profile";

  public static flags = {
    all: flags.boolean({
      char: "a",
      description: "delete items from all containers",
      required: false,
      default: false
    }),
    profile: flags.boolean({
      char: "p",
      description: "delete items from profile container",
      required: false,
      default: false
    }),
    message: flags.boolean({
      char: "m",
      description: "delete items from message container",
      required: false,
      default: false
    }),
    notification: flags.boolean({
      char: "n",
      description: "delete items from notification container",
      required: false,
      default: false
    }),
    service: flags.boolean({
      char: "s",
      description: "delete items from service container",
      required: false,
      default: false
    })
  };

  // tslint:disable-next-line:readonly-array
  public static args = [
    {
      name: "fiscalCode",
      required: true
    }
  ];

  async run() {
    const { args, flags } = this.parse(ProfileDelete);
    const fiscalCodeOrErrors = FiscalCode.decode(args.fiscalCode);
    if (fiscalCodeOrErrors.isLeft()) {
      this.error("provide a valid fiscal code");
      return;
    }
    const fiscalCode = fiscalCodeOrErrors.value;

    // define used queries
    const selectFromFiscalCode =
      "SELECT * FROM c WHERE c.fiscalCode = @fiscalCode";
    const paramsFromFiscalCode: cosmos.SqlParameter[] = [
      { name: "@fiscalCode", value: fiscalCode }
    ];

    const selectFromRecipientFiscalCode =
      "SELECT * FROM c WHERE c.recipientFiscalCode = @recipientFiscalCode";
    const paramsFromRecipientFiscalCode: cosmos.SqlParameter[] = [
      { name: "@recipientFiscalCode", value: fiscalCode }
    ];

    // retrive azure credentials
    cli.action.start("Retrieving cosmosdb credentials");
    const [connection, storageConnection] = await Promise.all([
      getCosmosConnection("agid-rg-test", "agid-cosmosdb-test"),
      getStorageConnection(config.storageName)
    ]);
    cli.action.stop();

    // define all delete operations
    const deleteOps: ReadonlyArray<DeleteOp> = [
      {
        containerName: "profiles",
        query: selectFromFiscalCode,
        queryParameters: paramsFromFiscalCode,
        relatedOps: [],
        deleteBlobs: false
      },
      {
        containerName: "messages",
        query: selectFromFiscalCode,
        queryParameters: paramsFromFiscalCode,
        relatedOps: [
          {
            containerName: "message-status"
          }
        ],
        deleteBlobs: true
      },
      {
        containerName: "notifications",
        query: selectFromFiscalCode,
        queryParameters: paramsFromFiscalCode,
        queryOptions: { enableCrossPartitionQuery: true },
        relatedOps: [
          {
            containerName: "notification-status"
          }
        ],
        deleteBlobs: false
      },
      {
        containerName: "sender-services",
        query: selectFromRecipientFiscalCode,
        queryParameters: paramsFromRecipientFiscalCode,
        relatedOps: [],
        deleteBlobs: false
      }
    ];

    // define the delete operation set from given inputs
    // if all flag is enabled all above defined options will be procecess
    // otherwhise only operations specified in the given flags
    const deleteOpsToProcess = flags.all
      ? deleteOps
      : deleteOps.filter(_ => {
          switch (_.containerName) {
            case "messages":
            case "message-status":
              return flags.message;
            case "notifications":
            case "notification-status":
              return flags.notification;
            case "profiles":
              return flags.profile;
            case "sender-services":
              return flags.service;
          }
        });
    if (deleteOpsToProcess.length === 0) {
      cli.error("please specify at least one container");
    }

    // init the cosmos client
    const client = new cosmos.CosmosClient({
      endpoint: connection.endpoint,
      auth: { key: connection.key }
    });

    const database = client.database("agid-documentdb-test");

    // apply processDeleteOpt to each delete operation
    const results = await sequential(deleteOpsToProcess, item =>
      this.processDeleteOpt(database, storageConnection, item)
    );
    const countDeleteItems = results.reduce(
      (acc, current) => acc + current.getOrElse(0),
      0
    );

    if (countDeleteItems > 0) {
      cli.log(`${countDeleteItems} total items successfully deleted`);
    } else {
      cli.log(`no items are been deleted`);
    }
  }

  /**
   * delete the given items from the given container
   * @param items the cosmos items to delete
   * @param container the continer where items are placed
   */
  private async deleteItems(
    items: ReadonlyArray<cosmos.Item>,
    container: cosmos.Container
  ): Promise<number> {
    if (items === undefined) {
      return 0;
    }
    cli.action.start(`Deleting ${items.length} items from ${container.id}`);
    const deletedItems = await sequentialSum(
      items,
      async currentOp =>
        await container
          .item(currentOp.id)
          .delete()
          .then(_ => 1)
          .catch(e => {
            cli.log(e);
            return 0;
          })
    );
    cli.action.stop();
    return deletedItems;
  }

  /**
   * for each item in relatedItems take the item contained in deleteOp container and delete them,
   * return the number of delete items
   * @param database the cosmos database where the container is placed
   * @param relatedItems the items to retrive from container specified in deleteOp
   * @param deleteOp the delete operation
   */
  private async processInnerDeleteOpt(
    database: cosmos.Database,
    relatedItems: ReadonlyArray<cosmos.Item>,
    deleteOp: DeleteOpInner
  ): Promise<number> {
    const innerContainer = database.container(deleteOp.containerName);
    const innerItems = relatedItems.map(m => innerContainer.item(m.id));
    if (innerItems.length > 0) {
      const confirmInner = await cli.confirm(
        `${innerItems.length} items found in "${
          deleteOp.containerName
        }" container! Are you sure you want to proceed to delete?`
      );
      if (confirmInner) {
        return await this.deleteItems(innerItems, innerContainer);
      }
    }
    return 0;
  }

  /**
   * process the given delete operation, retrieve items from delete operation container and delete them
   * @param database the cosmos database where deleteOp.container is placed
   * @param deleteOp the delete operation to process
   */
  private async processDeleteOpt(
    database: cosmos.Database,
    storageConnection: string,
    deleteOp: DeleteOp
  ): Promise<Option<number>> {
    try {
      cli.action.start(
        `Selecting items from "${deleteOp.containerName}" container...`
      );
      // get the container of the delete operation
      const container = database.container(deleteOp.containerName);
      // query the container
      const response = container.items.query(
        {
          parameters: deleteOp.queryParameters,
          query: deleteOp.query
        },
        deleteOp.queryOptions
      );
      const { result: itemsList } = await response.toArray();
      if (itemsList === undefined) {
        cli.action.stop(`No items found in ${deleteOp.containerName}...`);
        return none;
      }
      cli.action.stop();
      const confirm = await cli.confirm(
        `${itemsList.length} items found in "${
          deleteOp.containerName
        }" container! Are you sure you want to proceed to delete?`
      );
      if (!confirm) {
        return none;
      }
      // we have some elements to delete
      const deleteItems = await this.deleteItems(itemsList, container);

      // tslint:disable-next-line: no-let
      let deleteInnerItems = 0;
      // check if there are some related operations to process
      if (deleteOp.relatedOps.length > 0) {
        // apply processInnerDeleteOpt to each deleteOp.relatedOps items
        deleteInnerItems = await sequentialSum(deleteOp.relatedOps, item =>
          this.processInnerDeleteOpt(database, itemsList, item)
        );
      }
      // check if we have to delete blobs too
      if (deleteOp.deleteBlobs) {
        const confirmInner = await cli.confirm(
          `Are you sure to delete items in message-content storage?`
        );
        if (confirmInner) {
          deleteInnerItems += await this.processDeleteBlobOpt(
            storageConnection,
            itemsList
          );
        }
      }
      return some(deleteItems + deleteInnerItems);
    } catch (error) {
      this.error(error.body);
      return none;
    }
  }

  private async processDeleteBlobOpt(
    storageConnection: string,
    items: ReadonlyArray<cosmos.Item>
  ): Promise<number> {
    const blobService = storage.createBlobService(storageConnection);
    const doesBlobExist = (id: string) =>
      new Promise<storage.BlobService.BlobResult>((resolve, reject) =>
        blobService.doesBlobExist(
          config.storageMessagesContainer,
          id,
          (err, blobResult) => (err ? reject(err) : resolve(blobResult))
        )
      );
    const deletedBlobItems = await sequentialSum(items, async item => {
      // DELETE BLOB HERE
      const blobExist = await doesBlobExist(`${item.id}.json`);
      if (blobExist.exists) {
        return item.delete().then(_ => 1);
      }
      return 0;
    });
    if (deletedBlobItems > 0) {
      cli.log(`${deletedBlobItems} blob items successfully deleted`);
    }
    return deletedBlobItems;
  }
}