var NodeHelper = require("node_helper");
var request = require('request');
var convert = require('xml-js');
var buses = [];
var requestCount = 0;

module.exports = NodeHelper.create({

	start: function() {
		console.log('Starting node helper for: ' + this.name);
        this.loaded = false;
        self = this;
        setInterval(function() {
            self.readBuses();
            setTimeout(function(){
                self.broadcastMessage();
            }, 4000);
        }, 30000);	
    },

	socketNotificationReceived: function(notification, payload) {
		if (notification === 'SET_CONFIG') {
            this.config = payload;
            this.loaded = true;
            console.log(this.name + ': Connection started');

            // Read it immediately once
            self.readBuses();
            setTimeout(function(){
                self.broadcastMessage();
            }, 10000);
		}
	},

    readBuses: function() {
        if (this.loaded){
            self = this;
            stops = self.config.stopIds;
            if (!requestCount) buses = [];
            requestCount = stops.length;
            stops.forEach(function(stopId){
                self.getAtbStopTimes(stopId, function(error, data){
                    if(!error){
                        var routes = new Map();
                        for(i =0; i < data.buses.length; i++){
                            var bus = data.buses[i];
                            var key = bus.line;
                            var routeCount = routes.has(key) ? routes.get(key) : 0; 
                            var minutes = Math.round((self.toDate(bus.time) - (new Date())) / 60000);
                            if(routeCount < self.config.maxCount && minutes <= self.config.maxMinutes){
                                buses.push({
                                    number: bus.line,
                                    from: bus.name,
                                    to: bus.destination,
                                    time: bus.time
                                });
                            }
                        }
                    } else {
                        console.log(self.name + ': Request error: ' + error);
                    }
                    requestCount--;
                });
            });
        }
    },

	broadcastMessage: function() {
        self = this;
        buses.sort(function(a, b){
            return (self.toDate(a.time) - self.toDate(b.time));
        });
		this.sendSocketNotification('BUS_DATA', buses);
	},

    toDate: function(s){
        year = s.substring(0, 4);
        month = parseInt(s.substring(5, 7)) - 1;
        day = s.substring(8, 10);
        hour = s.substring(11, 13);
        minute = s.substring(14, 16);
        time = new Date(year, month, day, hour, minute, 0, 0);
        return time;
    },

    createAtbSmsXml: function(stopId){
        var currentTime = new Date();
        var requestTime = currentTime.getFullYear() + '-'
                        + (((currentTime.getMonth() + 1) < 10) ? '0' : '')
                        + (currentTime.getMonth() + 1) + '-'
                        + ((currentTime.getDate() < 10) ? '0' : '')
                        + currentTime.getDate() + 'T'
                        + ((currentTime.getHours() < 10) ? '0' : '')
                        + currentTime.getHours() + ':'
                        + ((currentTime.getMinutes() < 10) ? '0' : '')
                        + currentTime.getMinutes() + ':' 
                        + ((currentTime.getSeconds() < 10) ? '0' : '')
                        + currentTime.getSeconds() + '.'
                        + currentTime.getMilliseconds() + 'Z';
        var requestor = 'github.com/ottopaulsen/MMM-NesteBussAtB';
        var previewInterval = 'PT' + self.config.maxMinutes + 'M';
        var xml = `
        <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:siri="http://www.siri.org.uk/siri">
        <soapenv:Header/>
        <soapenv:Body>
            <siri:GetStopMonitoring>
                <ServiceRequestInfo>
                    <siri:RequestTimestamp>` + requestTime + `</siri:RequestTimestamp>
                    <siri:RequestorRef>` + requestor + `</siri:RequestorRef>
                </ServiceRequestInfo>
                <Request version="1.4">
                    <siri:RequestTimestamp>` + requestTime + `</siri:RequestTimestamp>
                    <siri:PreviewInterval>` + previewInterval + `</siri:PreviewInterval>
                    <siri:MonitoringRef>` + stopId + `</siri:MonitoringRef>
                </Request>
                <RequestExtension></RequestExtension>
            </siri:GetStopMonitoring>
        </soapenv:Body>
        </soapenv:Envelope>
        `;
        return xml;
    },
    
    getAtbStopTimes: function(stopId, handleResponse){
        self = this;
        request({
            headers: {
              'Content-Type': 'text/xml; charset=utf-8',
              'SoapAction': 'GetStopMonitoring'
            },
            uri: 'http://st.atb.no:90/SMWS/SMService.svc?WSDL',
            body: self.createAtbSmsXml(stopId),
            method: 'POST'
        }, function(err, res, body){
            result = {
                timestamp: '',
                buses: []
            }
            if(err){
                console.log('Error ' + err);
            } else {
                if(res.statusCode == 200){
                    xmlResult = convert.xml2js(body, {compact: true, spaces: 3});
                    //console.log(convert.xml2json(body, {compact: true, spaces: 3}));
    
                    xmlBody = xmlResult['s:Envelope']['s:Body'];
                    getStopMonitoringResponse = xmlBody['GetStopMonitoringResponse'];
                    serviceDeliveryInfo = getStopMonitoringResponse['ServiceDeliveryInfo'];
                    responseTimestamp = serviceDeliveryInfo['ResponseTimestamp']['_text'];
                    answer = getStopMonitoringResponse['Answer'];
                    stopMonitoringDelivery = answer['StopMonitoringDelivery'];
                    monitoredStopVisit = stopMonitoringDelivery['MonitoredStopVisit'];
                    if(monitoredStopVisit){
                        result.timestamp = responseTimestamp;
                        for(i=0; i < monitoredStopVisit.length; i++){
                            monitored = monitoredStopVisit[i]['MonitoredVehicleJourney']['Monitored']['_text'];
                            if(monitored == 'true'){
                                time = monitoredStopVisit[i]['MonitoredVehicleJourney']['MonitoredCall']['ExpectedDepartureTime']['_text'];
                            } else {
                                time = monitoredStopVisit[i]['MonitoredVehicleJourney']['MonitoredCall']['AimedDepartureTime']['_text'];
                            }
                            result.buses[i] = {
                                line: monitoredStopVisit[i]['MonitoredVehicleJourney']['PublishedLineName']['_text'],
                                destination: monitoredStopVisit[i]['MonitoredVehicleJourney']['DestinationName']['_text'],
                                time: time,
                                name: monitoredStopVisit[i]['MonitoredVehicleJourney']['MonitoredCall']['StopPointName']['_text']
                            }
                        }
                    }
                } else {
                    console.log('The AtB SMService returned status code ' + res.statusCode);
                }
            }
            handleResponse(err, result);
        });
    }
        
});