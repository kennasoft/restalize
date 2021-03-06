import moment from "moment";
import {
  Connection,
  ColumnType,
  MoreThan,
  MoreThanOrEqual,
  LessThan,
  LessThanOrEqual,
  Like,
  In,
  Between,
  Not,
  Equal,
  IsNull,
} from "typeorm";
import { ColumnMetadata } from "typeorm/metadata/ColumnMetadata";

import dbConn from "../../utils/db";
import { intTypes, floatTypes, dateTypes } from "../../utils/type-mappings";
import { RelationMetadata } from "typeorm/metadata/RelationMetadata";

export type RelationFragment = {
  name: string;
  select: string[];
};

export type FilterAttributes = {
  select?: string[];
  relations: string[];
  relationFragments: RelationFragment[];
};

export default class Manager<Entity> {
  connect: Promise<Connection>;
  type: { new (init?: Partial<Entity>): Entity };
  constructor(type: { new (init?: Partial<Entity>): Entity }) {
    this.type = type;
    this.connect = dbConn;
  }

  closeConnection = () => {
    this.connect
      .then((conn) => {
        conn.isConnected && conn.close();
      })
      .catch(console.error);
  };

  getPrimaryKeyColumnNames(db: Connection): string[] {
    const columnMeta: ColumnMetadata[] = db.getMetadata(this.type)
      .primaryColumns;
    return columnMeta.map((col) => col.propertyName);
  }

  _validateFields(
    params = {} as Record<string, any>,
    db: Connection
  ): boolean | string[] {
    const metadata = db.getMetadata(this.type);
    const relationNames: string[] = metadata.relations.map(
      (rel: RelationMetadata) => rel.propertyName
    );
    const columnNames: string[] = metadata.columns.map(
      (col: ColumnMetadata) => col.propertyName
    );

    const invalidFields: string[] = [];
    for (const key in params) {
      if (!columnNames.includes(key) && !relationNames.includes(key)) {
        invalidFields.push(key);
      }
    }
    if (invalidFields.length) {
      return invalidFields;
    } else {
      return true;
    }
  }

  _pickAttributes(
    attribs: string | string[],
    conn: Connection
  ): FilterAttributes | undefined {
    if (attribs) {
      if (typeof attribs === "string") {
        attribs = attribs.split(",");
      }
      const relationFragments = attribs
        .filter((attrib) => /\(.+\)/.test(attrib))
        .map((rel) => {
          const [_, relName, fields] = rel.match(
            /(.+)\((.+)\)/
          ) as RegExpMatchArray;
          return {
            name: relName,
            select: fields.split("|"),
          };
        });
      const metadata = conn.getMetadata(this.type);
      const validColumns = metadata.columns.map(
        (col: ColumnMetadata) => col.propertyName
      );
      const relationNames: string[] = metadata.ownRelations.map(
        (r) => r.propertyName
      );
      let select: string[] | undefined = attribs.filter(
        (attr: string) =>
          !relationNames.includes(attr) && validColumns.includes(attr)
      );
      let relations: string[] = [];
      let nestedRelations = attribs.filter((attr) => attr.indexOf(".") > -1);
      if (relationNames.length) {
        relations = relationNames
          .filter(
            (rel) =>
              attribs.includes(rel) ||
              relationFragments.map((pr) => pr.name).includes(rel)
          )
          .concat(nestedRelations);
      }
      const id = metadata.primaryColumns[0].propertyName;
      if (
        relations.length > 0 &&
        validColumns.includes(id) &&
        !select.includes(id)
      ) {
        select.push(id);
      }
      if (select.length === 0) {
        select = undefined;
      }
      return { select, relations, relationFragments };
    }
  }

  _buildWhereClause(params: Record<string, any>, conn: Connection) {
    const whereClause: Record<string, any> = {};
    const self = this;
    const metadata = conn.getMetadata(this.type);
    const columnMetadata = metadata.columns;

    const applyOperator = (operator: string, param: string, value: any) => {
      if (!operator || operator === "eq") {
        whereClause[param] = value;
      } else {
        switch (operator) {
          case "gt":
            whereClause[param] = MoreThan(value);
            break;
          case "gte":
            whereClause[param] = MoreThanOrEqual(value);
            break;
          case "lt":
            whereClause[param] = LessThan(value);
            break;
          case "lte":
            whereClause[param] = LessThanOrEqual(value);
            break;
          case "ne":
            whereClause[param] = Not(Equal(value));
            break;
          case "not":
            whereClause[param] = Not(value);
            break;
          case "in":
            whereClause[param] = In(Array.isArray(value) ? value : [value]);
            break;
          case "between":
            whereClause[param] = Between(value[0], value[1]);
            break;
          case "like":
            let val: string = value;
            val = val.startsWith("*") ? `%${val.slice(1)}` : val;
            val = val.endsWith("*") ? `${val.slice(0, -1)}%` : val;
            val = val.includes("%") ? val : `%${val}%`;
            whereClause[param] = Like(val);
            break;
        }
      }
    };
    // if primary key is not named {id}, make sure it's included in params
    if (params.id) {
      const pk = metadata.primaryColumns[0];
      params[pk.propertyName] = params.id;
    }
    Object.keys(params).forEach(function (paramName) {
      let [param, operator, xtraOperator] = paramName.split(".");
      const column = columnMetadata.find(
        (col: ColumnMetadata) => col.propertyName === param
      );
      if (column) {
        let fieldType: string | ColumnType = column.type;
        let value;
        try {
          value = self._convertValue(fieldType, params[paramName]);
        } catch (err) {
          throw new Error(`${err.message} ${param}`);
        }
        if (xtraOperator && operator === "not") {
          applyOperator(xtraOperator, param, value);
          applyOperator(operator, param, whereClause[param]);
        } else {
          applyOperator(operator, param, value);
        }
      }
    });
    return whereClause;
  }

  _convertValue(sqlType: string | ColumnType, value: any) {
    let val =
      typeof value === "string"
        ? value.split(",")
        : Array.isArray(value)
        ? value
        : [value];
    if (dateTypes.includes(sqlType as string) || sqlType === Date) {
      val = val.map((v: string) => {
        if (v === null || String.prototype.toLowerCase.call(v) === "null") {
          return IsNull();
        }
        let theDate;
        try {
          theDate = moment(v).toDate();
        } catch (err) {
          throw new Error(`Invalid date value '${v}' found for param`);
        }
        return theDate;
      });
    } else if (
      intTypes.includes(sqlType as string) ||
      floatTypes.includes(sqlType as string)
    ) {
      val = val.map((v: string) => {
        if (v === null || String.prototype.toLowerCase.call(v) === "null") {
          return IsNull();
        }
        const intVal = String.prototype.includes.call(v, ".")
          ? parseFloat(v)
          : parseInt(v);
        if (isNaN(intVal)) {
          throw new Error(`Invalid numeric value '${v}' found for param`);
        }
        return intVal;
      });
    } else if (
      val.length === 1 &&
      (val[0] === null || String.prototype.toLowerCase.call(val[0]) === "null")
    ) {
      val[0] = IsNull();
    }
    return val.length === 1 ? val[0] : val;
  }
}

module.exports = Manager;
