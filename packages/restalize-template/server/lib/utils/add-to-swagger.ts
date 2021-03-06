import { EntityMetadata, Connection, ObjectType } from "typeorm";
import { ColumnMetadata } from "typeorm/metadata/ColumnMetadata";
import { RelationMetadata } from "typeorm/metadata/RelationMetadata";
import pluralize from "pluralize";
import fs from "fs";
import path from "path";

import dbConn from "./db";
import { mapSQLTypeToSwagger } from "./type-mappings";

export type TSwaggerJSON = {
  swagger?: string;
  info?: {
    description: string;
    title: string;
    version: string;
  };
  host?: string;
  basePath?: string;
  tags: Record<string, any>[];
  schemes?: string[];
  paths: Record<string, any>;
  definitions: Record<string, any>;
};

export const defaultSwagger: TSwaggerJSON = {
  swagger: "2.0",
  info: {
    description:
      "This is an auto-generated API to access resources at http://localhost:3000/api",
    title: "Restalize API",
    version: "1.0.0",
  },
  host: "localhost:3000",
  basePath: "/api",
  tags: [],
  schemes: ["http", "https"],
  paths: {},
  definitions: {},
};

const queue = {
  waiting: [] as any[],
  busy: false,
};

const patchQueue = {
  waiting: [] as TSwaggerJSON[],
  busy: false,
};

export const patchSwagger = async (
  swaggerJSON: TSwaggerJSON
): Promise<TSwaggerJSON | void> => {
  const swaggerFile = path.join(__dirname, "..", "..", "docs", "swagger.json");

  if (
    (queue.waiting.length || queue.busy) &&
    !patchQueue.waiting.includes(swaggerJSON)
  ) {
    //defer for later if promise queue is not empty
    patchQueue.waiting.push(swaggerJSON);
    return;
  }

  if (patchQueue.busy && !patchQueue.waiting.includes(swaggerJSON)) {
    patchQueue.waiting.push(swaggerJSON);
    return;
  }

  let currentSwagger: TSwaggerJSON;

  patchQueue.busy = true;

  return new Promise((resolve, reject) => {
    //@ts-ignore
    fs.readFile(
      swaggerFile,
      "utf8",
      (err: NodeJS.ErrnoException, data: string) => {
        if (err) {
          reject();
          return console.log(err);
        }
        currentSwagger = defaultSwagger;
        if (data) {
          currentSwagger = JSON.parse(data);
        }
        // patch it
        currentSwagger = {
          ...currentSwagger,
          paths: { ...currentSwagger.paths, ...swaggerJSON.paths },
          definitions: {
            ...currentSwagger.definitions,
            ...swaggerJSON.definitions,
          },
        };
        swaggerJSON.tags?.map((tag: any) => {
          const exists = currentSwagger.tags?.find((t) => t.name === tag.name);
          if (exists) {
            exists.name = tag.name;
            exists.description = tag.description;
          } else {
            currentSwagger.tags?.push(tag);
          }
        });
        // overwrite file
        fs.writeFileSync(
          swaggerFile,
          JSON.stringify(currentSwagger, null, 2),
          "utf8"
        );
        patchQueue.busy = false;
        if (patchQueue.waiting.length) {
          const nextPatch = patchQueue.waiting.shift() as TSwaggerJSON;
          return patchSwagger(nextPatch);
        }
        return resolve(currentSwagger);
      }
    );
  });
};

export default async function addToSwagger<Entity>(
  entity: ObjectType<Entity>,
  swaggerJSON: any
): Promise<TSwaggerJSON | void> {
  if (queue.busy && !queue.waiting.includes(entity)) {
    queue.waiting.push(entity);
    return;
  } else {
    queue.busy = true;
  }
  const db: Connection = await dbConn;
  const entityMeta: EntityMetadata = db.getMetadata(entity);
  swaggerJSON.definitions[`${entity.name}`] = {
    type: "object",
    properties: entityMeta.columns
      .map((col: ColumnMetadata) => {
        const typeMap = mapSQLTypeToSwagger(col.type as string);
        return {
          [col.propertyName]: {
            type: typeMap[0],
            example: typeMap[1],
          },
        };
      })
      .reduce((acc: any, curr: any) => ({ ...acc, ...curr }), {}),
  };

  swaggerJSON.definitions[`${pluralize(entity.name, 1)}ResultList`] = {
    type: "object",
    properties: {
      status: {
        type: "string",
        example: "success",
      },
      data: {
        type: "object",
        properties: {
          total: {
            type: "integer",
            description: "Total number of records matching the criteria",
            example: 100,
          },
          subtotal: {
            type: "integer",
            description: "Number of items returned based on _pageSize_ param",
            example: 20,
          },
          currentPage: {
            type: "integer",
            description: "Current page number in the result set",
            example: 5,
          },
          totalPages: {
            type: "integer",
            description: "Total pages in the result set",
            example: 40,
          },
          rows: {
            type: "array",
            items: {
              $ref: `#/definitions/${entity.name}`,
            },
          },
        },
      },
    },
  };

  if (entityMeta.ownRelations.length > 0) {
    entityMeta.ownRelations.map((rel: RelationMetadata) => {
      if (rel.isOneToMany || rel.isManyToMany) {
        swaggerJSON.definitions[`${entity.name}`].properties[
          rel.propertyName
        ] = {
          type: "array",
          items: {
            // @ts-ignore
            $ref: `#/definitions/${rel.type.name}`,
          },
        };
      } else {
        swaggerJSON.definitions[`${entity.name}`].properties[
          rel.propertyName
        ] = {
          // @ts-ignore
          $ref: `#/definitions/${rel.type.name}`,
        };
      }
    });
  }
  swaggerJSON.tags.push({
    name: entity.name,
    description: `Access to all ${pluralize(entity.name, 1)} endpoints`,
  });

  const orderAndPagination = [
    {
      name: "_select_",
      in: "query",
      required: false,
      description:
        "comma-separated list of fields to be returned in the results.",
      type: "string",
      example: "id,name,category,tags",
    },
    {
      name: "_orderBy_",
      in: "query",
      required: false,
      description:
        "specify a field to sort the results by, and the sort order. E.g. email.DESC",
      type: "string",
      example: "email.DESC",
    },
    {
      name: "_page_",
      in: "query",
      required: false,
      description:
        "specify page number of results. Combines with _pageSize_ to get offset",
      type: "number",
      example: 3,
    },
    {
      name: "_pageSize_",
      in: "query",
      required: false,
      description: "specify number of records to return per page.",
      type: "number",
      example: 20,
    },
  ];

  const getErrorObject = (code: number) => {
    const resp = {
      properties: {
        status: {
          type: "string",
          example: "error",
        },
        message: {
          type: "string",
          example: "There was an error processing your request",
        },
        code: {
          type: "number",
          example: 500,
        },
        type: {
          type: "string",
          example: "InternalServerError",
        },
      },
    };
    switch (code) {
      case 400:
        resp.properties.message.example = "Bad Request";
        resp.properties.type.example = "BadRequestError";
        resp.properties.code.example = 400;
        return resp;
      case 401:
        resp.properties.message.example = "Unauthorized access";
        resp.properties.type.example = "UnauthorizedError";
        resp.properties.code.example = 401;
        return resp;
      case 403:
        resp.properties.message.example = "Forbidden";
        resp.properties.type.example = "ForbiddenError";
        resp.properties.code.example = 403;
        return resp;
      case 404:
        resp.properties.message.example = "Error: Record not found";
        resp.properties.type.example = "NotFoundError";
        resp.properties.code.example = 404;
        return resp;
      default:
        return resp;
    }
  };

  const errorSchema = {
    "400": getErrorObject(400),
    "401": getErrorObject(401),
    "403": getErrorObject(403),
    "404": getErrorObject(404),
    "500": getErrorObject(500),
  };

  const restMethodProps = (
    entityMeta: EntityMetadata,
    paramSource = "query",
    additionalParams = [] as any[]
  ) => {
    return {
      tags: [entityMeta.name],
      produces: ["application/json"],
      parameters: [
        ...entityMeta.columns.map((col: ColumnMetadata) => ({
          name: col.propertyName,
          in: paramSource,
          required: false,
          type: mapSQLTypeToSwagger(col.type as string)[0],
          description: col.comment,
        })),
        ...additionalParams,
      ],
    };
  };

  swaggerJSON.paths[`/${pluralize(entity.name)}`] = {
    get: {
      operationId: `getAll${pluralize(entity.name)}`,
      description: `Gets a list of ${pluralize(
        entity.name
      )} based on query parameters`,
      ...restMethodProps(entityMeta, "query", orderAndPagination),
      responses: {
        200: {
          description: `returns an object with count summaries(total, subtotal) and a list of ${pluralize(
            entity.name
          )} (rows)`,
          schema: {
            $ref: `#/definitions/${pluralize(entity.name, 1)}ResultList`,
          },
        },
        400: {
          description: "Error: Bad Request",
          schema: errorSchema["400"],
        },
        404: {
          description: `Error: ${entity.name} not found`,
          schema: errorSchema["404"],
        },
      },
    },
    post: {
      operationId: `create${pluralize(entity.name, 1)}`,
      description: `Bulk Creates a collection of ${pluralize(
        entity.name
      )} passed as JSON in the request body`,
      tags: [entity.name],
      produces: ["application/json"],
      parameters: [
        {
          name: "entityJSON",
          in: "body",
          required: true,
          description: `A JSON object/array containing the ${pluralize(
            entityMeta.name,
            1
          )}(s) to be created`,
          schema: {
            $ref: `#/definitions/${entity.name}`,
          },
        },
      ],
      responses: {
        400: {
          description: "Error: unauthorized access",
          schema: errorSchema["400"],
        },
        404: {
          description: `Error ${entity.name} not found`,
          schema: errorSchema["404"],
        },
      },
    },
    put: {
      operationId: `update${pluralize(entity.name)}`,
      description: `Updates a collection of ${pluralize(
        entity.name
      )} that match query parameters or {condition} object in body`,
      ...restMethodProps(entityMeta, "query", [
        {
          name: "updatePayload",
          in: "body",
          required: true,
          description: `A JSON object containing the ${pluralize(
            entityMeta.name,
            1
          )} fields to be updated`,
          schema: {
            properties: {
              updateFields: {
                description: `Fields that need to be updated on the ${pluralize(
                  entity.name,
                  1
                )}`,
                $ref: `#/definitions/${entity.name}`,
              },
              condition: {
                description: `Search conditions`,
                $ref: `#/definitions/${entity.name}`,
              },
            },
          },
        },
      ]),
      responses: {
        400: {
          description: "Error: unauthorized access",
          schema: errorSchema["400"],
        },
        404: {
          description: `Error ${entity.name} not found`,
          schema: errorSchema["404"],
        },
      },
    },
    delete: {
      operationId: `delete${pluralize(entity.name)}`,
      description: `Deletes a collection of ${pluralize(
        entity.name
      )} based on query parameters. Use with caution as this action is irreversible`,
      ...restMethodProps(entityMeta),
      responses: {
        400: {
          description: "Error: unauthorized access",
          schema: errorSchema["400"],
        },
        404: {
          description: `Error ${entity.name} not found`,
          schema: errorSchema["404"],
        },
      },
    },
  };
  swaggerJSON.paths[`/${pluralize(entity.name)}/{id}`] = {
    get: {
      operationId: `get${pluralize(entity.name, 1)}ById`,
      description: `Gets single instance of ${pluralize(
        entity.name,
        1
      )} by the id specified in the path`,
      tags: [entityMeta.name],
      produces: ["application/json"],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          type: mapSQLTypeToSwagger(
            entityMeta.primaryColumns[0].type as string
          )[0],
          description: `The primary key field with which to lookup the ${entityMeta.name}`,
        },
      ],
      responses: {
        400: {
          description: "Error: unauthorized access",
          schema: errorSchema["400"],
        },
        404: {
          description: `Error ${entity.name} not found`,
          schema: errorSchema["404"],
        },
      },
    },
    put: {
      operationId: `update${pluralize(entity.name, 1)}ById`,
      description: `Updates a single ${pluralize(
        entity.name,
        1
      )} that matches the id in the path with the updateFields in the body`,
      tags: [entity.name],
      produces: ["application/json"],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          type: mapSQLTypeToSwagger(
            entityMeta.primaryColumns[0].type as string
          )[0],
          description: `The primary key field of the ${pluralize(
            entityMeta.name,
            1
          )} to be updated`,
        },
        {
          name: "updateFields",
          in: "body",
          required: true,
          description: `A JSON object containing some fields of the ${pluralize(
            entityMeta.name,
            1
          )} to be updated`,
          schema: {
            $ref: `#/definitions/${entity.name}`,
          },
        },
      ],
      responses: {
        400: {
          description: "Error: unauthorized access",
          schema: errorSchema["400"],
        },
        404: {
          description: `Error ${entity.name} not found`,
          schema: errorSchema["404"],
        },
      },
    },
    delete: {
      operationId: `delete${pluralize(entity.name, 1)}ById`,
      description: `Deletes specific instance of ${pluralize(
        entity.name,
        1
      )} that matches the id in the path. Use with caution as this action is irreversible`,
      tags: [entity.name],
      produces: ["application/json"],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          type: mapSQLTypeToSwagger(
            entityMeta.primaryColumns[0].type as string
          )[0],
          description: `The primary key field of the ${pluralize(
            entityMeta.name,
            1
          )} to be deleted.`,
        },
      ],
      responses: {
        400: {
          description: "Error: unauthorized access",
          schema: errorSchema["400"],
        },
        404: {
          description: `Error ${entity.name} not found`,
          schema: errorSchema["404"],
        },
      },
    },
  };
  queue.busy = false;
  if (queue.waiting.length > 0) {
    addToSwagger(queue.waiting.shift(), swaggerJSON);
  } else {
    const swaggerFile = path.join(
      __dirname,
      "..",
      "..",
      "docs",
      "swagger.json"
    );
    return new Promise((resolve, reject) => {
      try {
        fs.writeFileSync(swaggerFile, JSON.stringify(swaggerJSON, null, 2));
      } catch (err) {
        reject(err);
      }
      return resolve(swaggerJSON);
    });
  }
}
