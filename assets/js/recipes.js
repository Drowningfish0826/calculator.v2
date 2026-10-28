/* ============================================================================
 * recipes.js — 內建例題與管理科學模型範本
 * ----------------------------------------------------------------------------
 * 每個範本都走同一條流程：資料輸入 → 自動建立模型 → 求解 → 結果分析。
 * ==========================================================================*/
(function (global) {
  'use strict';

  var LPC = (global.LPC = global.LPC || {});
  var model = LPC.model;

  /* --------------------------------------------------------------------- */
  /* 內建例題                                                              */
  /* --------------------------------------------------------------------- */

  var examples = [
    {
      id: 'assignment-demo',
      name: '作業示範例題',
      tagline: '兩變數、兩資源的入門題，適合課堂開場',
      tags: ['最大化', '≤ 型'],
      build: function () {
        return model.create({
          sense: 'max',
          varNames: ['x1', 'x2'],
          c: ['20', '15'],
          constraints: [
            { a: ['2', '1'], op: '<=', b: '20', label: '人力' },
            { a: ['1', '3'], op: '<=', b: '35', label: '原料' }
          ],
          meta: {
            objectiveLabel: '總利潤',
            objectiveUnit: '元',
            variableUnit: '單位',
            variableLabels: ['產品 A', '產品 B'],
            resourceLabels: ['人力上限', '原料上限'],
            resourceUnits: ['小時', '公斤']
          }
        });
      }
    },
    {
      id: 'production-mix',
      name: '生產組合決策',
      tagline: '兩條產線、三種資源，找出最賺錢的生產配比',
      tags: ['最大化', '≤ 型', '圖形分析'],
      build: function () {
        return model.create({
          sense: 'max',
          varNames: ['x1', 'x2'],
          c: ['50', '40'],
          constraints: [
            { a: ['2', '1'], op: '<=', b: '120', label: '人力工時' },
            { a: ['1', '2'], op: '<=', b: '120', label: '原料用量' },
            { a: ['1', '0'], op: '<=', b: '50', label: '需求上限' }
          ],
          meta: {
            objectiveLabel: '總利潤',
            objectiveUnit: '千元',
            variableUnit: '單位',
            variableLabels: ['產品 A', '產品 B'],
            resourceLabels: ['人力工時', '原料供應', '產品 A 需求上限']
          }
        });
      }
    },
    {
      id: 'media-plan',
      name: '媒體投放配置',
      tagline: '三個媒體管道、有限預算，極大化總曝光',
      tags: ['最大化', '3 變數'],
      build: function () {
        return model.create({
          sense: 'max',
          varNames: ['x1', 'x2', 'x3'],
          c: ['800', '150', '300'],
          constraints: [
            { a: ['20', '5', '8'], op: '<=', b: '200', label: '行銷預算' },
            { a: ['1', '0', '0'], op: '<=', b: '6', label: '電視檔次上限' },
            { a: ['0', '1', '0'], op: '<=', b: '20', label: '社群貼文上限' },
            { a: ['0', '0', '1'], op: '<=', b: '15', label: '搜尋廣告上限' }
          ],
          meta: {
            objectiveLabel: '總曝光量',
            objectiveUnit: '萬次',
            variableUnit: '單位',
            variableLabels: ['電視廣告', '社群貼文', '搜尋廣告'],
            resourceLabels: ['行銷預算', '電視檔次', '社群則數', '搜尋組數']
          }
        });
      }
    },
    {
      id: 'feed-mix',
      name: '飼料配方（最小成本）',
      tagline: '兩種原料、兩項營養門檻，求最低成本配方',
      tags: ['最小化', '≥ 型', '圖形分析'],
      build: function () {
        return model.create({
          sense: 'min',
          varNames: ['x1', 'x2'],
          c: ['30', '20'],
          constraints: [
            { a: ['3', '1'], op: '>=', b: '18', label: '蛋白質需求' },
            { a: ['1', '2'], op: '>=', b: '16', label: '熱量需求' }
          ],
          meta: {
            objectiveLabel: '配方成本',
            objectiveUnit: '元',
            variableUnit: '公斤',
            variableLabels: ['原料 A', '原料 B'],
            resourceLabels: ['蛋白質下限', '熱量下限']
          }
        });
      }
    },
    {
      id: 'project-select',
      name: '專案選擇（0-1 規劃）',
      tagline: '資源有限、專案不可分割，示範整數規劃',
      tags: ['最大化', '0-1 變數', '整數規劃'],
      build: function () {
        return model.create({
          sense: 'max',
          varNames: ['x1', 'x2', 'x3', 'x4'],
          c: ['10', '13', '18', '31'],
          binary: [true, true, true, true],
          constraints: [
            { a: ['1', '2', '4', '7'], op: '<=', b: '10', label: '工程師人力' },
            { a: ['3', '1', '2', '1'], op: '<=', b: '9', label: '設備時數' }
          ],
          meta: {
            objectiveLabel: '總效益',
            objectiveUnit: '百萬',
            variableUnit: '',
            variableLabels: ['專案 A', '專案 B', '專案 C', '專案 D'],
            resourceLabels: ['工程師人力', '設備時數']
          }
        });
      }
    },
    {
      id: 'blend-hotel',
      name: '旅館客房定價（3 變數）',
      tagline: '三種房型、清潔人力與訂房上限，極大化住房收入',
      tags: ['最大化', '3 變數'],
      build: function () {
        return model.create({
          sense: 'max',
          varNames: ['x1', 'x2', 'x3'],
          c: ['3200', '2600', '1800'],
          constraints: [
            { a: ['1', '1', '1'], op: '<=', b: '90', label: '可售房數' },
            { a: ['2', '1.5', '1'], op: '<=', b: '150', label: '清潔工時' },
            { a: ['1', '0', '0'], op: '<=', b: '30', label: '套房上限' },
            { a: ['0', '1', '0'], op: '<=', b: '45', label: '雙人房上限' }
          ],
          meta: {
            objectiveLabel: '總住房收入',
            objectiveUnit: '元',
            variableUnit: '間',
            variableLabels: ['套房', '雙人房', '單人房'],
            resourceLabels: ['可售房數', '清潔工時', '套房上限', '雙人房上限']
          }
        });
      }
    }
  ];

  /* --------------------------------------------------------------------- */
  /* 範本：運輸問題                                                        */
  /* --------------------------------------------------------------------- */

  function buildTransport(input) {
    var rows = input.rows;
    var cols = input.cols;
    var cells = input.cells;
    var supply = rows.map(function (row) {
      return Number(row.total) || 0;
    });
    var demand = cols.map(function (col) {
      return Number(col.total) || 0;
    });
    var totalSupply = supply.reduce(function (sum, value) {
      return sum + value;
    }, 0);
    var totalDemand = demand.reduce(function (sum, value) {
      return sum + value;
    }, 0);
    var notes = [];
    var rowNames = rows.map(function (row, index) {
      return row.name || 'S' + (index + 1);
    });
    var colNames = cols.map(function (col, index) {
      return col.name || 'D' + (index + 1);
    });
    var cost = cells.map(function (line) {
      return line.map(function (value) {
        return Number(value) || 0;
      });
    });

    if (totalSupply > totalDemand) {
      colNames = colNames.concat(['（未分配）']);
      demand = demand.concat([totalSupply - totalDemand]);
      cost = cost.map(function (line) {
        return line.concat([0]);
      });
      notes.push(
        '供給量（' + totalSupply + '）大於需求量（' + totalDemand + '），已自動加入成本為 0 的虛擬需求地吸收剩餘供給。'
      );
    } else if (totalDemand > totalSupply) {
      rowNames = rowNames.concat(['（虛擬供給）']);
      supply = supply.concat([totalDemand - totalSupply]);
      cost = cost.concat([
        new Array(colNames.length).fill(0)
      ]);
      notes.push(
        '需求量（' + totalDemand + '）大於供給量（' + totalSupply + '），已自動加入成本為 0 的虛擬供給地補足缺口。'
      );
    }

    var rowCount = rowNames.length;
    var colCount = colNames.length;
    var varNames = [];
    var objective = [];
    var variableLabels = [];
    var indexOf = function (rowIndex, colIndex) {
      return rowIndex * colCount + colIndex;
    };

    for (var i = 0; i < rowCount; i += 1) {
      for (var j = 0; j < colCount; j += 1) {
        varNames.push('x' + (i + 1) + (j + 1));
        objective.push(String(cost[i][j]));
        variableLabels.push(rowNames[i] + '→' + colNames[j]);
      }
    }

    var constraints = [];
    var resourceLabels = [];
    for (var rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      var supplyRow = new Array(varNames.length).fill('0');
      for (var colIndex = 0; colIndex < colCount; colIndex += 1) {
        supplyRow[indexOf(rowIndex, colIndex)] = '1';
      }
      constraints.push({
        a: supplyRow,
        op: '=',
        b: String(supply[rowIndex]),
        label: rowNames[rowIndex] + ' 供應量'
      });
      resourceLabels.push(rowNames[rowIndex] + ' 供應量');
    }
    for (var colPosition = 0; colPosition < colCount; colPosition += 1) {
      var demandRow = new Array(varNames.length).fill('0');
      for (var sourceIndex = 0; sourceIndex < rowCount; sourceIndex += 1) {
        demandRow[indexOf(sourceIndex, colPosition)] = '1';
      }
      constraints.push({
        a: demandRow,
        op: '=',
        b: String(demand[colPosition]),
        label: colNames[colPosition] + ' 需求量'
      });
      resourceLabels.push(colNames[colPosition] + ' 需求量');
    }

    var built = model.create({
      sense: 'min',
      varNames: varNames,
      c: objective,
      constraints: constraints,
      meta: {
        kind: 'transport',
        objectiveLabel: '總運輸成本',
        objectiveUnit: '元',
        variableUnit: '單位',
        variableLabels: variableLabels,
        resourceLabels: resourceLabels,
        grid: {
          rowNames: rowNames,
          colNames: colNames,
          supply: supply,
          demand: demand,
          cost: cost,
          notes: notes
        }
      }
    });
    return { model: built, notes: notes };
  }

  /* --------------------------------------------------------------------- */
  /* 範本：指派問題                                                        */
  /* --------------------------------------------------------------------- */

  function buildAssignment(input) {
    var people = input.rows.map(function (row, index) {
      return row.name || 'P' + (index + 1);
    });
    var tasks = input.cols.map(function (col, index) {
      return col.name || 'T' + (index + 1);
    });
    var cost = input.cells.map(function (line) {
      return line.map(function (value) {
        return Number(value) || 0;
      });
    });
    var size = Math.max(people.length, tasks.length);
    var varNames = [];
    var objective = [];
    var variableLabels = [];
    for (var i = 0; i < size; i += 1) {
      for (var j = 0; j < size; j += 1) {
        varNames.push('x' + (i + 1) + (j + 1));
        var cellValue =
          cost[i] && cost[i][j] !== undefined ? Number(cost[i][j]) : 0;
        objective.push(String(cellValue));
        variableLabels.push(
          (people[i] || 'P' + (i + 1)) + '→' + (tasks[j] || 'T' + (j + 1))
        );
      }
    }

    var constraints = [];
    var resourceLabels = [];
    for (var personIndex = 0; personIndex < size; personIndex += 1) {
      var personRow = new Array(varNames.length).fill('0');
      for (var taskIndex = 0; taskIndex < size; taskIndex += 1) {
        personRow[personIndex * size + taskIndex] = '1';
      }
      constraints.push({
        a: personRow,
        op: '=',
        b: '1',
        label: (people[personIndex] || 'P' + (personIndex + 1)) + ' 只做一件'
      });
      resourceLabels.push((people[personIndex] || 'P' + (personIndex + 1)) + ' 指派限制');
    }
    for (var columnIndex = 0; columnIndex < size; columnIndex += 1) {
      var taskRow = new Array(varNames.length).fill('0');
      for (var otherIndex = 0; otherIndex < size; otherIndex += 1) {
        taskRow[otherIndex * size + columnIndex] = '1';
      }
      constraints.push({
        a: taskRow,
        op: '=',
        b: '1',
        label: (tasks[columnIndex] || 'T' + (columnIndex + 1)) + ' 恰由一人'
      });
      resourceLabels.push((tasks[columnIndex] || 'T' + (columnIndex + 1)) + ' 指派限制');
    }

    var built = model.create({
      sense: 'min',
      varNames: varNames,
      c: objective,
      constraints: constraints,
      meta: {
        kind: 'assignment',
        objectiveLabel: '總指派成本',
        objectiveUnit: '元',
        variableUnit: '單位',
        variableLabels: variableLabels,
        resourceLabels: resourceLabels,
        grid: {
          rowNames: people,
          colNames: tasks,
          cost: cost,
          notes: []
        }
      }
    });
    return { model: built, notes: [] };
  }

  /* --------------------------------------------------------------------- */
  /* 範本：生產計劃                                                        */
  /* --------------------------------------------------------------------- */

  function buildProduction(input) {
    var resources = input.rows.map(function (row, index) {
      return {
        name: row.name || '資源' + (index + 1),
        total: Number(row.total) || 0
      };
    });
    var products = input.cols.map(function (col, index) {
      return {
        name: col.name || '產品' + (index + 1),
        total: Number(col.total) || 0
      };
    });
    var usage = input.cells.map(function (line) {
      return line.map(function (value) {
        return Number(value) || 0;
      });
    });
    var varNames = products.map(function (product, index) {
      return 'x' + (index + 1);
    });
    var constraints = resources.map(function (resource, resourceIndex) {
      return {
        a: products.map(function (product, productIndex) {
          return String(usage[resourceIndex][productIndex]);
        }),
        op: '<=',
        b: String(resource.total),
        label: resource.name
      };
    });

    var built = model.create({
      sense: 'max',
      varNames: varNames,
      c: products.map(function (product) {
        return String(product.total);
      }),
      constraints: constraints,
      meta: {
        kind: 'production',
        objectiveLabel: '總利潤',
        objectiveUnit: '元',
        variableUnit: '單位',
        variableLabels: products.map(function (product) {
          return product.name;
        }),
        resourceLabels: resources.map(function (resource) {
          return resource.name;
        }),
        grid: {
          rowNames: resources.map(function (resource) {
            return resource.name;
          }),
          colNames: products.map(function (product) {
            return product.name;
          }),
          supply: resources.map(function (resource) {
            return resource.total;
          }),
          demand: products.map(function (product) {
            return product.total;
          }),
          cost: usage
        }
      }
    });
    return { model: built, notes: [] };
  }

  /* --------------------------------------------------------------------- */
  /* 範本描述（供 UI 建立表單）                                            */
  /* --------------------------------------------------------------------- */

  var templates = [
    {
      id: 'transport',
      name: '運輸問題',
      subtitle: 'Transportation Problem',
      description: '從多個供給地把貨物運到多個需求地，在供需平衡下找出最低總運輸成本。',
      build: buildTransport,
      form: {
        rowAxis: { label: '供給地', totalLabel: '供應量', prefix: 'S', unit: '單位' },
        colAxis: { label: '需求地', totalLabel: '需求量', prefix: 'D', unit: '單位' },
        cellLabel: '單位運輸成本',
        rows: ['S1', 'S2', 'S3'],
        cols: ['A', 'B', 'C', 'D'],
        rowTotals: [300, 300, 250],
        colTotals: [250, 350, 150, 100],
        cells: [
          [16, 18, 11, 20],
          [14, 12, 13, 17],
          [13, 15, 17, 18]
        ]
      }
    },
    {
      id: 'assignment',
      name: '指派問題',
      subtitle: 'Assignment Problem',
      description: '把 n 件工作分派給 n 個人，每人一件、每件一人，求總成本最低的分派。',
      build: buildAssignment,
      form: {
        rowAxis: { label: '人員', totalLabel: '', prefix: 'P', unit: '' },
        colAxis: { label: '工作', totalLabel: '', prefix: 'T', unit: '' },
        cellLabel: '指派成本',
        rows: ['王', '李', '陳', '林'],
        cols: ['專案甲', '專案乙', '專案丙', '專案丁'],
        rowTotals: [1, 1, 1, 1],
        colTotals: [1, 1, 1, 1],
        cells: [
          [10, 12, 19, 11],
          [5, 10, 7, 8],
          [12, 14, 17, 20],
          [8, 9, 11, 10]
        ]
      }
    },
    {
      id: 'production',
      name: '生產計劃',
      subtitle: 'Production Planning',
      description: '多種產品共用多項資源，在資源上限下決定各產品生產量以極大化利潤。',
      build: buildProduction,
      form: {
        rowAxis: { label: '資源', totalLabel: '可用量', prefix: '資源', unit: '' },
        colAxis: { label: '產品', totalLabel: '單位利潤', prefix: '產品', unit: '元' },
        cellLabel: '單位耗用量',
        rows: ['人力工時', '原料', '機台時數'],
        cols: ['產品 A', '產品 B', '產品 C'],
        rowTotals: [240, 180, 120],
        colTotals: [50, 40, 60],
        cells: [
          [2, 1, 3],
          [1, 2, 2],
          [1, 1, 2]
        ]
      }
    }
  ];

  LPC.examples = examples;
  LPC.templates = templates;
  LPC.findExample = function (id) {
    for (var index = 0; index < examples.length; index += 1) {
      if (examples[index].id === id) {
        return examples[index];
      }
    }
    return null;
  };
  LPC.findTemplate = function (id) {
    for (var index = 0; index < templates.length; index += 1) {
      if (templates[index].id === id) {
        return templates[index];
      }
    }
    return null;
  };
})(typeof window !== 'undefined' ? window : globalThis);
