/* v_Where .rdl builder
 *
 * Turns a report draft into a ConfigMgr-ready SSRS report definition (.rdl): open it in
 * Report Builder, or upload it to the reporting point's folder in the SSRS web portal.
 *
 * What makes a report a ConfigMgr report, copied from Microsoft's own report template:
 *   - Data source: the shared one the reporting point creates,
 *       /ConfigMgr_<SiteCode>/{5C6358F2-4BB6-4a1b-A16E-8D96795D8602}
 *   - Permissions (RBAC): two hidden parameters.
 *       UserTokenSIDs = SrsResources.UserIdentity.GetUserSIDs(User!UserID)   who is running the report
 *       UserSIDs      = fn_rbac_GetAdminIDsfromUserSIDs(@UserTokenSIDs)       what their console role allows
 *     Every fn_rbac_ function takes @UserSIDs, so people only see devices their role covers.
 *     SrsResources is a code module the reporting point installs on the report server.
 *   - Collection picker: a CollectionID parameter whose list comes from fn_rbac_Collection.
 *
 * The layout is plain on purpose: a title, the collection and row count, and one table with
 * sortable headers. Formatting is quicker to fix in Report Builder than to guess here.
 * Schema: RDL 2008/01 (what Microsoft's template uses); Report Builder upgrades it on save.
 */
(function (root) {
  'use strict';

  const NS = 'http://schemas.microsoft.com/sqlserver/reporting/2008/01/reportdefinition';
  const NS_RD = 'http://schemas.microsoft.com/SQLServer/reporting/reportdesigner';
  const CM_DATASOURCE = '{5C6358F2-4BB6-4a1b-A16E-8D96795D8602}';
  const DS_NAME = 'AutoGen__5C6358F2_4BB6_4a1b_A16E_8D96795D8602_';   // same name built-in reports use
  const ALL_SYSTEMS = 'SMS00001';

  const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const guid = () => (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  const inch = (n) => `${Math.round(n * 1000) / 1000}in`;

  // SQL type ("nvarchar(255)", "datetime") -> .NET type Report Builder shows for the field
  function netType(sqlType) {
    const t = String(sqlType || '').toLowerCase().replace(/\(.*$/, '').trim();
    return ({
      int: 'System.Int32', bigint: 'System.Int64', smallint: 'System.Int16', tinyint: 'System.Byte', bit: 'System.Boolean',
      datetime: 'System.DateTime', datetime2: 'System.DateTime', smalldatetime: 'System.DateTime', date: 'System.DateTime',
      datetimeoffset: 'System.DateTimeOffset', uniqueidentifier: 'System.Guid', decimal: 'System.Decimal',
      numeric: 'System.Decimal', money: 'System.Decimal', float: 'System.Double', real: 'System.Single',
    })[t] || 'System.String';
  }

  // "Last Boot Up Time" -> "Last_Boot_Up_Time": report field names must be identifiers
  function fieldNames(headers) {
    const used = new Set();
    return headers.map(h => {
      let n = h.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'Field';
      if (/^[0-9]/.test(n)) n = 'F_' + n;
      let f = n, i = 2;
      while (used.has(f.toLowerCase())) f = `${n}_${i++}`;
      used.add(f.toLowerCase());
      return f;
    });
  }

  function textbox(name, value, style, extra = '') {
    return `<Textbox Name="${x(name)}">
          <CanGrow>true</CanGrow>
          <KeepTogether>true</KeepTogether>
          <Paragraphs><Paragraph><TextRuns><TextRun><Value>${x(value)}</Value><Style>${style.run || ''}</Style></TextRun></TextRuns><Style /></Paragraph></Paragraphs>
          ${extra}
          <Style>${style.box || ''}<PaddingLeft>3pt</PaddingLeft><PaddingRight>3pt</PaddingRight><PaddingTop>2pt</PaddingTop><PaddingBottom>2pt</PaddingBottom></Style>
        </Textbox>`;
  }
  const BORDER = '<Border><Color>#D0D7E2</Color><Style>Solid</Style></Border>';

  /**
   * build(opts) -> .rdl XML text
   *   title       report name, shown at the top
   *   siteCode    ConfigMgr site code (data source path)
   *   sql         the dataset query (use the fn_rbac_ / @UserSIDs version)
   *   columns     [{ name, type }] : name = the column alias in the query, type = SQL type
   *   collection  true if the query uses @CollectionID
   *   params      [{ name, prompt, default, rdl }] filter parameters the query uses (@name); rdl = SSRS data type
   */
  function build(opts) {
    const title = (opts.title || 'Report draft').trim();
    const site = String(opts.siteCode || '').trim().toUpperCase();
    const sql = opts.sql;
    const cols = opts.columns;
    const rbac = /@UserSIDs\b/i.test(sql);
    const coll = !!opts.collection && /@CollectionID\b/i.test(sql);
    const fields = fieldNames(cols.map(c => c.name));
    const widths = cols.map(c => Math.min(2.8, Math.max(0.9, 0.7 + 0.085 * c.name.length)));
    const tableWidth = widths.reduce((a, b) => a + b, 0);
    const bodyWidth = Math.max(tableWidth, 6.5);
    const landscape = bodyWidth > 7.5;

    // ---- Data sets ----
    const userSidsParam = rbac ? `<QueryParameter Name="@UserSIDs"><Value>=Parameters!UserSIDs.Value</Value></QueryParameter>` : '';
    const sets = [];
    if (rbac) sets.push(`<DataSet Name="DataSetAdminID">
      <Query>
        <DataSourceName>${DS_NAME}</DataSourceName>
        <QueryParameters><QueryParameter Name="@UserTokenSIDs"><Value>=Parameters!UserTokenSIDs.Value</Value></QueryParameter></QueryParameters>
        <CommandText>select dbo.fn_rbac_GetAdminIDsfromUserSIDs(@UserTokenSIDs) as UserSIDs</CommandText>
      </Query>
      <Fields><Field Name="UserSIDs"><DataField>UserSIDs</DataField><rd:TypeName>System.String</rd:TypeName></Field></Fields>
    </DataSet>`);
    if (coll) sets.push(`<DataSet Name="Collections">
      <Query>
        <DataSourceName>${DS_NAME}</DataSourceName>
        ${rbac ? `<QueryParameters>${userSidsParam}</QueryParameters>` : ''}
        <CommandText>${x(`SELECT CollectionID, Name FROM ${rbac ? 'fn_rbac_Collection(@UserSIDs)' : 'v_Collection'} WHERE CollectionType = 2 ORDER BY Name`)}</CommandText>
      </Query>
      <Fields>
        <Field Name="CollectionID"><DataField>CollectionID</DataField><rd:TypeName>System.String</rd:TypeName></Field>
        <Field Name="Name"><DataField>Name</DataField><rd:TypeName>System.String</rd:TypeName></Field>
      </Fields>
    </DataSet>`);
    const fparams = (opts.params || []).filter(p => new RegExp('@' + p.name + '\\b', 'i').test(sql));
    const qp = [userSidsParam, coll ? `<QueryParameter Name="@CollectionID"><Value>=Parameters!CollectionID.Value</Value></QueryParameter>` : '',
      ...fparams.map(p => `<QueryParameter Name="@${x(p.name)}"><Value>=Parameters!${x(p.name)}.Value</Value></QueryParameter>`)].join('');
    sets.push(`<DataSet Name="Main">
      <Query>
        <DataSourceName>${DS_NAME}</DataSourceName>
        ${qp ? `<QueryParameters>${qp}</QueryParameters>` : ''}
        <CommandText>${x(sql)}</CommandText>
      </Query>
      <Fields>
        ${cols.map((c, i) => `<Field Name="${fields[i]}"><DataField>${x(c.name)}</DataField><rd:TypeName>${netType(c.type)}</rd:TypeName></Field>`).join('\n        ')}
      </Fields>
    </DataSet>`);

    // ---- Table: header row (sortable, repeats on each page) + detail row (banded) ----
    const head = cols.map((c, i) => `<TablixCell><CellContents>
        ${textbox('Header_' + fields[i], c.name,
          { run: '<FontWeight>Bold</FontWeight>', box: BORDER + '<BackgroundColor>#E3EAF6</BackgroundColor><VerticalAlign>Middle</VerticalAlign>' },
          `<UserSort><SortExpression>=Fields!${fields[i]}.Value</SortExpression></UserSort>`)}
      </CellContents></TablixCell>`).join('');
    const detail = cols.map((c, i) => {
      const date = netType(c.type) === 'System.DateTime';
      return `<TablixCell><CellContents>
        ${textbox(fields[i], `=Fields!${fields[i]}.Value`,
          { run: date ? '<Format>g</Format>' : '', box: BORDER + '<BackgroundColor>=IIf(RowNumber(Nothing) Mod 2 = 0, "#F5F7FA", "White")</BackgroundColor>' })}
      </CellContents></TablixCell>`;
    }).join('');
    const tablix = `<Tablix Name="Table">
        <TablixBody>
          <TablixColumns>${widths.map(w => `<TablixColumn><Width>${inch(w)}</Width></TablixColumn>`).join('')}</TablixColumns>
          <TablixRows>
            <TablixRow><Height>0.28in</Height><TablixCells>${head}</TablixCells></TablixRow>
            <TablixRow><Height>0.25in</Height><TablixCells>${detail}</TablixCells></TablixRow>
          </TablixRows>
        </TablixBody>
        <TablixColumnHierarchy><TablixMembers>${cols.map(() => '<TablixMember />').join('')}</TablixMembers></TablixColumnHierarchy>
        <TablixRowHierarchy><TablixMembers>
          <TablixMember><KeepWithGroup>After</KeepWithGroup><RepeatOnNewPage>true</RepeatOnNewPage></TablixMember>
          <TablixMember><Group Name="Details" /></TablixMember>
        </TablixMembers></TablixRowHierarchy>
        <RepeatColumnHeaders>true</RepeatColumnHeaders>
        <DataSetName>Main</DataSetName>
        <NoRowsMessage>No rows. Check the collection, or whether the inventory class is collected.</NoRowsMessage>
        <Top>0.7in</Top><Left>0in</Left><Height>0.53in</Height><Width>${inch(tableWidth)}</Width>
        <Style><Border><Style>None</Style></Border></Style>
      </Tablix>`;
    const subtitle = (coll ? '="Collection: " & Parameters!CollectionID.Label & "   |   " & ' : '=')
      + fparams.map(p => `"${p.prompt.replace(/"/g, '""')}: " & Parameters!${p.name}.Value & "   |   " & `).join('')
      + 'CountRows("Main") & " rows   |   " & Format(Globals!ExecutionTime, "g")';

    // ---- Parameters ----
    const params = [];
    if (rbac) params.push(`<ReportParameter Name="UserTokenSIDs">
      <DataType>String</DataType>
      <DefaultValue><Values><Value>=SrsResources.UserIdentity.GetUserSIDs(User!UserID)</Value></Values></DefaultValue>
      <Prompt>UserTokenSIDs</Prompt>
      <Hidden>true</Hidden>
    </ReportParameter>`, `<ReportParameter Name="UserSIDs">
      <DataType>String</DataType>
      <DefaultValue><DataSetReference><DataSetName>DataSetAdminID</DataSetName><ValueField>UserSIDs</ValueField></DataSetReference></DefaultValue>
      <Prompt>UserSIDs</Prompt>
      <Hidden>true</Hidden>
    </ReportParameter>`);
    if (coll) params.push(`<ReportParameter Name="CollectionID">
      <DataType>String</DataType>
      <DefaultValue><Values><Value>${ALL_SYSTEMS}</Value></Values></DefaultValue>
      <Prompt>Collection</Prompt>
      <ValidValues><DataSetReference><DataSetName>Collections</DataSetName><ValueField>CollectionID</ValueField><LabelField>Name</LabelField></DataSetReference></ValidValues>
    </ReportParameter>`);
    // Filter parameters: the report asks for each, with the value typed in v_Where as the default
    for (const p of fparams) params.push(`<ReportParameter Name="${x(p.name)}">
      <DataType>${x(p.rdl || 'String')}</DataType>
      ${p.default !== '' && p.default != null ? `<DefaultValue><Values><Value>${x(p.default)}</Value></Values></DefaultValue>` : ''}
      ${(p.rdl || 'String') === 'String' ? '<AllowBlank>true</AllowBlank>' : '<Nullable>true</Nullable>'}
      <Prompt>${x(p.prompt || p.name)}</Prompt>
    </ReportParameter>`);

    return `<?xml version="1.0" encoding="utf-8"?>
<Report xmlns:rd="${NS_RD}" xmlns="${NS}">
  <Description>${x(`Built with v_Where (https://jboogieman.github.io/v-where/). Columns: ${cols.map(c => c.name).join(', ')}.`)}</Description>
  <AutoRefresh>0</AutoRefresh>
  <DataSources>
    <DataSource Name="${DS_NAME}">
      <DataSourceReference>/ConfigMgr_${x(site)}/${CM_DATASOURCE}</DataSourceReference>
      <rd:SecurityType>None</rd:SecurityType>
      <rd:DataSourceID>${guid()}</rd:DataSourceID>
    </DataSource>
  </DataSources>
  <DataSets>
    ${sets.join('\n    ')}
  </DataSets>
  <Body>
    <ReportItems>
      ${textbox('Title', title, { run: '<FontSize>16pt</FontSize><FontWeight>Bold</FontWeight>' }).replace('<CanGrow>', `<rd:DefaultName>Title</rd:DefaultName><Top>0in</Top><Left>0in</Left><Height>0.38in</Height><Width>${inch(bodyWidth)}</Width><CanGrow>`)}
      ${textbox('Subtitle', subtitle, { run: '<FontSize>9pt</FontSize><Color>#5D6677</Color>' }).replace('<CanGrow>', `<Top>0.4in</Top><Left>0in</Left><Height>0.22in</Height><Width>${inch(bodyWidth)}</Width><CanGrow>`)}
      ${tablix}
    </ReportItems>
    <Height>1.4in</Height>
    <Style />
  </Body>
  ${params.length ? `<ReportParameters>\n    ${params.join('\n    ')}\n  </ReportParameters>` : ''}
  ${rbac ? '<CodeModules><CodeModule>SrsResources, culture=neutral</CodeModule></CodeModules>' : ''}
  <Width>${inch(bodyWidth)}</Width>
  <Page>
    <PageHeight>${landscape ? '8.5in' : '11in'}</PageHeight>
    <PageWidth>${landscape ? '11in' : '8.5in'}</PageWidth>
    <LeftMargin>0.5in</LeftMargin><RightMargin>0.5in</RightMargin><TopMargin>0.5in</TopMargin><BottomMargin>0.5in</BottomMargin>
    <Style />
  </Page>
  <Language>en-US</Language>
  <ConsumeContainerWhitespace>true</ConsumeContainerWhitespace>
  <rd:ReportUnitType>Inch</rd:ReportUnitType>
  <rd:ReportID>${guid()}</rd:ReportID>
</Report>
`;
  }

  // "Device inventory: Q4" -> "Device inventory Q4.rdl"
  const fileName = (title) => ((title || 'Report draft').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Report draft') + '.rdl';

  const api = { build, fileName, netType, fieldNames, CM_DATASOURCE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VWhereRDL = api;
})(this);
